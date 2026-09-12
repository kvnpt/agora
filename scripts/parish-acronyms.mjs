// An acronym for every parish that has none.
//
// An acronym is a parish's short link: orthodoxy.au/smg opens Sts Michael &
// Gabriel, and /smg/donate goes straight to their giving page. Six parishes
// had one, typed by hand; the other hundred and ninety had no short link at
// all, which is the whole point of the acronym.
//
// THE SHAPE IS TAKEN FROM THE SIX. They are initials of the dedication, three
// or four letters, with the suburb supplying the rest when the dedication runs
// short:
//
//     SMM   St Mary Magdalene, Elimbah
//     SMG   Sts Michael & Gabriel, Ryde
//     SPP   Sts Peter and Paul, Doonside
//     SPW   St Paul, Woolloongabba        <- two from the dedication, one from the suburb
//     GSM   Good Shepherd Mission, Clayton
//     SJFC  St John Forerunner, Redlynch
//
// THE SUBURB IS NOT DECORATION. Five parishes are called St Sava and four St
// Nicholas; without the suburb they would be one link between them. So the
// ladder below reaches for the suburb the moment a dedication collides, and
// keeps reaching — first letter, then two, then the initials of a two-word
// suburb — before it will accept anything arbitrary.
//
// It never touches a parish that already has one. A short link is printed on
// pew sheets and posters; changing one breaks paper nobody can recall.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const slugs = require('../public/shared/slugs.js');
const { normaliseSlug, reservedSlugReason } = slugs;

// Words that name nothing on their own. "of the Most Holy Theotokos" is four
// words and one idea; dropping these leaves Dormition + Theotokos, which is
// what somebody would abbreviate.
const STOP = new Set(['of', 'the', 'and', 'in', 'at', 'for', 'a', 'an', 'our']);
const QUALIFIER = new Set(['most', 'holy', 'all', 'new', 'great', 'blessed']);

const letters = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z]/g, '');

function words(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z]+/).filter(Boolean);
}

/**
 * The letters a dedication contributes, in order.
 *
 * The dedication is what precedes the comma: a stored name is
 * "<dedication>, <suburb>" and "All Saints, Belmore" abbreviates to ASB, not
 * to SB with Belmore mistaken for part of the title.
 *
 * "St" and "Sts" count as one S — that is what SPP and SMG do. A qualifier is
 * kept while the dedication is short enough to spell out, because "Holy Cross"
 * is the dedication and HC is how anyone would write it; it is dropped only
 * once there are more than three words, where it is an epithet in front of the
 * name rather than the name — "Dormition of the Most Holy Theotokos" is DT.
 */
export function dedicationInitials(name) {
  const ws = words(String(name || '').split(',')[0]).filter((w) => !STOP.has(w.toLowerCase()));
  if (ws.length <= 3) return ws.map((w) => w[0].toUpperCase());
  const solid = ws.filter((w) => !QUALIFIER.has(w.toLowerCase()));
  return (solid.length ? solid : ws).map((w) => w[0].toUpperCase());
}

/** The parish's own suburb: what follows the comma in "St Sava, Highgate". */
export function suburbOf(name, fallback) {
  const after = String(name || '').split(',').slice(1).join(' ').trim();
  return after || String(fallback || '').trim();
}

/**
 * Candidate acronyms, best first.
 *
 * Every one is three or four letters. The order is the argument: a dedication
 * that identifies the parish on its own wins, then the dedication plus as much
 * of the suburb as it takes to be unique, and only then anything that has to
 * be explained.
 */
export function* candidatesFor(name, suburbFallback) {
  const D = dedicationInitials(name);
  const suburb = suburbOf(name, suburbFallback);
  const SW = words(suburb).map((w) => w[0].toUpperCase());   // "Homebush West" -> H, W
  const SL = letters(suburb);                                // -> HOMEBUSHWEST
  const d = (n) => D.slice(0, n).join('');

  if (D.length >= 3) yield d(3);                       // SPP, SMG, SMM
  if (D.length >= 2 && SW[0]) yield d(2) + SW[0];      // SPW  (St Paul + Woolloongabba)
  if (D.length >= 1 && SW[0] && SL[1]) yield d(1) + SL[0] + SL[1];
  if (D.length >= 3 && SW[0]) yield d(3) + SW[0];      // SJFC-shaped
  if (D.length >= 4) yield d(4);
  if (D.length >= 2 && SW.length >= 2) yield d(2) + SW[0] + SW[1];
  if (D.length >= 2 && SL.length >= 2) yield d(2) + SL[0] + SL[1];
  if (D.length >= 3 && SL.length >= 2) yield d(3) + SL[1];
  // Still colliding: walk the suburb's own letters, which at least keeps the
  // acronym about this parish rather than about a counter.
  for (const c of SL.slice(0, 8)) {
    if (D.length >= 3) yield d(3) + c;
    if (D.length >= 2) yield d(2) + SL[0] + c;
  }
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (D.length >= 2) yield d(2) + (SW[0] || SL[0] || 'X') + c;
  }
}

/**
 * Assign an acronym to every parish that lacks one.
 *
 * `taken` starts as the acronyms already in use, because the six that exist
 * are the ones printed on paper. Deterministic: parishes are processed in id
 * order, so a re-run against the same database produces the same answers, and
 * a re-run against a database that has grown only adds.
 */
export function assignAcronyms(parishes) {
  const taken = new Set();
  for (const p of parishes) {
    const slug = normaliseSlug(p.acronym);
    if (slug) taken.add(slug);
  }
  const assigned = [];
  const failed = [];
  const sorted = [...parishes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const p of sorted) {
    if (normaliseSlug(p.acronym)) continue;
    if (p.id === '_unassigned') continue;
    let chosen = null;
    for (const cand of candidatesFor(p.name, p.suburb)) {
      if (cand.length < 3 || cand.length > 4) continue;
      const slug = normaliseSlug(cand);
      if (taken.has(slug) || reservedSlugReason(slug)) continue;
      chosen = cand;
      break;
    }
    if (!chosen) { failed.push(p); continue; }
    taken.add(normaliseSlug(chosen));
    assigned.push({ id: p.id, name: p.name, acronym: chosen });
  }
  return { assigned, failed };
}

const sql = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * The write, guarded twice.
 *
 * `WHERE acronym IS NULL OR acronym = ''` so a re-run cannot overwrite an
 * acronym somebody has since typed, even if this file would now derive a
 * different one — the same reasoning as the import upsert's own guard.
 */
export function buildAcronymSql(assigned) {
  return assigned.map(({ id, acronym }) =>
    `UPDATE parishes SET acronym = ${sql(acronym)}\n WHERE id = ${sql(id)} AND (acronym IS NULL OR acronym = '');`
  ).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const LIVE = process.argv[2] || 'https://agora.orthodoxy.au/api/parishes';
  const output = process.argv[3] || './parish-acronyms.sql';

  const body = LIVE.startsWith('http')
    ? await (await fetch(LIVE, { headers: { 'User-Agent': 'agora-parish-import/1.0' } })).json()
    : JSON.parse(await (await import('node:fs/promises')).readFile(LIVE, 'utf8'));
  const parishes = (Array.isArray(body) ? body : body.parishes || []).filter((p) => p.id !== '_unassigned');

  const { assigned, failed } = assignAcronyms(parishes);
  const already = parishes.filter((p) => normaliseSlug(p.acronym));

  console.log(`${parishes.length} parishes — ${already.length} already have one, ${assigned.length} assigned here`);
  console.log('\nKEPT (never touched):');
  for (const p of already) console.log(`  ${String(p.acronym).padEnd(6)} ${p.name}`);

  console.log('\nASSIGNED:');
  for (const a of assigned) console.log(`  ${a.acronym.padEnd(6)} ${a.name}`);

  if (failed.length) {
    console.log('\nNO ACRONYM FOUND — these need a person:');
    for (const p of failed) console.log(`  ${p.id}  ${p.name}`);
  }

  const { writeFile } = await import('node:fs/promises');
  await writeFile(output,
    `-- Acronyms for the ${assigned.length} parishes that had none.\n`
    + '-- Generated by scripts/parish-acronyms.mjs. Existing acronyms are untouched,\n'
    + '-- and the guard means a re-run cannot overwrite one typed since.\n\n'
    + `${buildAcronymSql(assigned)}\n`);
  console.log(`\nwrote ${output}`);
}
