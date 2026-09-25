// Turning a scraped jurisdiction directory into parish rows.
//
// WHY THIS EXISTS
//
// Each jurisdiction publishes its directory differently, so the fetching and
// parsing is written fresh every time and does not belong here. What repeats is
// everything AFTER parsing: minting an id, working out which scraped parishes
// are already in the database, and writing them without destroying anything.
// That part went wrong in instructive ways on the first run, so it is written
// down as code with tests rather than as prose nobody reads twice.
//
// THE FAILURE THIS PREVENTS. A directory scrape mints ids by derivation, and
// derivation cannot reproduce an id somebody typed by hand. The Antiochian rows
// seeded before any scraping include:
//
//     antiochian-good-shepherd-antiochian-church    "The Good Shepherd, Clayton"
//
// — hyphenated inside the name, naming the jurisdiction twice, and not
// containing its suburb at all. No rule will ever derive that. Re-scraping the
// Antiochian directory and trusting derivation therefore inserts a SECOND Good
// Shepherd, and because the Google Calendar adapter names the old id, every
// event stays on the old row while an empty duplicate appears beside it.
//
// Worse, the mismatch is partial: "St John the Baptist" and "Sts Peter & Paul"
// happen to derive back to their existing ids while "St Mary's" and "Sts Michael
// & Gabriel" do not. Some rows update, some duplicate, and the result is far
// harder to notice than a clean failure.
//
// So `reconcile` matches on CONTENT — suburb plus dedication — and hands back a
// pin list to be read by a human before anything is written. It deliberately
// refuses to guess: a scraped parish matching two existing rows is reported as
// ambiguous rather than resolved.
//
// Import-side only. Nothing in the Worker imports this.

import { pinnedFields, governingTier, outranks } from '../worker/lib/info-overrides.mjs';

const STOP = new Set(['the', 'of', 'our', 'and', 'a', 'an', 'in', 'at', 'for']);

// Words describing the institution rather than naming it. Dropping them keeps
// the dedication in the id: "Archdiocesan Church of St Sophia" -> stsophia.
//
// The second line arrived with the Russian directory, which is the first one
// that lists anywhere other than parish churches. Without them "Orthodox
// Monastery of the Archangel Michael" mints `monastery`, having spent the whole
// length cap on the word every monastery shares.
const GENERIC = new Set(['church', 'parish', 'orthodox', 'cathedral',
  'archdiocesan', 'community', 'greek', 'antiochian', 'serbian', 'russian',
  'romanian', 'macedonian',
  'monastery', 'convent', 'skete', 'chapel', 'mission', 'institute']);

// Words that qualify a dedication without naming one. They are kept normally —
// "Holy Trinity" is the dedication — but a name that the length cap has reduced
// to nothing BUT one of these has been reduced to nothing at all.
const QUALIFIER = new Set(['holy', 'all', 'new', 'most', 'great']);

// Honorifics carry no distinguishing information — every second parish starts
// with one — so they are dropped when COMPARING two names, though kept when
// building an id because the existing rows keep them.
const HONORIFIC = new Set(['st', 'sts', 'saint', 'saints']);

const NAME_CAP = 16;   // an id reads badly past this; 62 chars was the first try
const SUBURB_CAP = 14;

const words = (s) => (s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
  .replace(/\(.*?\)/g, ' ')                            // drop parentheticals
  .replace(/[&']/g, ' ')
  .split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());

// Take whole words up to the cap. Returns the words rather than the joined
// string, because trimming a dangling honorific afterwards has to work on
// TOKENS: "baptist" and "coast" both end in "st" without ending in a saint, and
// chopping the string gives stjohnbapti and sunshinecoa.
function squeeze(list, cap) {
  const out = [];
  for (const w of list) {
    if (out.length && out.join('').length + w.length > cap) break;
    out.push(w);
  }
  return out.length ? out : [(list[0] || '').slice(0, cap)].filter(Boolean);
}

/**
 * `<jurisdiction>-<name>-<suburb>`, matching the rows already in the database.
 *
 * The length cap can strip a trailing honorific and leave a dangling "st", so
 * "St Paraskevi, St John The Merciful & St Barbara" becomes stparaskevi rather
 * than stparaskevist — which is also what the hand-written Blacktown id says.
 */
export function parishId(jurisdiction, name, suburb) {
  const significant = words(name).filter((w) => !STOP.has(w));
  const named = significant.filter((w) => !GENERIC.has(w));
  const candidates = named.length ? named : significant;
  let kept = squeeze(candidates, NAME_CAP);
  // "Holy Transfiguration Monastery" caps to `holy`, because transfiguration is
  // fifteen characters and will not fit beside it. A bare qualifier identifies
  // nothing, so when the cap collapses a name to one, drop it and take what
  // follows: `transfiguration` is the monastery, `holy` is every second parish.
  if (kept.length === 1 && kept.length < candidates.length && QUALIFIER.has(kept[0])) {
    kept = squeeze(candidates.slice(1), NAME_CAP);
  }
  // Drop a trailing honorific only when the cap actually stranded it, meaning
  // it introduces a saint whose name did not fit. When every word fits, a
  // trailing "Saints" is the dedication itself — "All Saints" is not "All".
  if (kept.length > 1 && kept.length < candidates.length
      && HONORIFIC.has(kept[kept.length - 1])) kept.pop();
  // And the same for a stranded qualifier, for the same reason. "Dormition of
  // the Most Holy Theotokos" caps to `dormitionmost`, where "most" is half of
  // "Most Holy" and qualifies a word that did not fit — it reads as a typo and
  // identifies nothing that `dormition` does not. The Serbian directory has
  // four of these. As above, only when the cap stranded it: a name that ENDS
  // in a qualifier because that is the dedication ("Christ the Great High
  // Priest") keeps it.
  // A loop, because "Entrance of the Most Holy Theotokos" fits `most` AND
  // `holy` inside the cap and strands them both — one pop leaves
  // `entrancemost`, which is the same typo one word later.
  while (kept.length > 1 && kept.length < candidates.length
      && QUALIFIER.has(kept[kept.length - 1])) kept.pop();
  const where = squeeze(words(suburb).filter((w) => !STOP.has(w)), SUBURB_CAP);
  return [jurisdiction, kept.join(''), where.join('')].filter(Boolean).join('-');
}

// Tokens that actually distinguish one parish from another. Trailing "s" goes
// so that "St Mary's" and "St Mary" compare equal.
const distinctive = (name) => new Set(
  words(name)
    .filter((w) => !STOP.has(w) && !GENERIC.has(w) && !HONORIFIC.has(w))
    .map((w) => w.replace(/s$/, ''))
    .filter(Boolean));

const flat = (s) => words(s).join('');

// Existing rows follow the convention "<dedication>, <suburb>", so the suburb is
// recoverable from the name; the address is checked too, for rows that do not.
function sameSuburb(scrapedSuburb, existing) {
  const want = flat(scrapedSuburb);
  if (!want) return false;
  const fromName = flat((existing.name || '').split(',').slice(1).join(' '));
  if (fromName && fromName === want) return true;
  return flat(existing.address || '').includes(want);
}

/**
 * Match scraped parishes against the rows already in the database.
 *
 * Returns `{ pinned, fresh, ambiguous }`. `pinned` entries carry the EXISTING
 * id, which is what the write must use — never the derived one. `ambiguous` is
 * for a human; it is never resolved automatically.
 */
export function reconcile(scraped, existing) {
  const pinned = [];
  const fresh = [];
  const ambiguous = [];

  for (const s of scraped) {
    const want = distinctive(s.name);
    const candidates = existing.filter((e) => {
      if (s.jurisdiction && e.jurisdiction && s.jurisdiction !== e.jurisdiction) return false;
      if (!sameSuburb(s.suburb, e)) return false;
      const have = distinctive(e.name);
      return [...want].some((w) => have.has(w));
    });

    if (candidates.length === 1) {
      pinned.push({ ...s, id: candidates[0].id, derived_id: parishId(s.jurisdiction, s.name, s.suburb), matched: candidates[0] });
    } else if (candidates.length > 1) {
      ambiguous.push({ ...s, candidates: candidates.map((c) => c.id) });
    } else {
      fresh.push({ ...s, id: parishId(s.jurisdiction, s.name, s.suburb) });
    }
  }
  return { pinned, fresh, ambiguous };
}

const sql = (v) => (v === null || v === undefined || v === ''
  ? 'NULL'
  : `'${String(v).replace(/'/g, "''")}'`);

const COLUMNS = ['id', 'name', 'jurisdiction', 'address', 'lat', 'lng', 'timezone',
  'website', 'phone', 'email', 'languages', 'color', 'feast_day',
  'info_source_type', 'info_source_ref', 'info_source_name', 'info_checked_at'];

// Columns a re-run may refresh. id and jurisdiction are identity; languages,
// color and info_verified_at are set by people, not by scrapes.
//
// `info_source_type` travels with `info_source_ref` and always did — leaving it
// out was an oversight, and it cost real rows. The ROCOR run first wrote
// 'website' for addresses it had taken from a third-party directory, and when
// the classification was corrected the re-run silently could not apply it:
// twenty-two rows kept asserting the parish had told us something it had not.
// The pair describes one fact, so it is refreshed as one fact.
//
// `info_checked_at` refreshes for the same reason and more plainly: a re-run IS
// a fresh read of the source, and the parish sheet renders the date as how old
// the details are. A re-run that left it alone would scrape a directory again
// and keep telling readers the row is six months stale.
const REFRESHABLE = ['name', 'address', 'lat', 'lng', 'timezone', 'website',
  'phone', 'email', 'feast_day', 'info_source_type', 'info_source_ref',
  'info_source_name', 'info_checked_at'];

/**
 * The upsert, guarded so a re-run cannot undo human work.
 *
 * `DO UPDATE ... WHERE parishes.info_verified_at IS NULL` is the whole point:
 * re-geocoding a parish that already had a confirmed pin moved it 784m, so once
 * somebody checks a pin and stamps the row, a later scrape must leave it alone.
 * Rows arrive here with an explicit id — from `reconcile`, not from derivation.
 *
 * It guards on `info_verified_at` and NEVER on `info_checked_at`, which is the
 * whole reason those are two columns rather than one. Every import stamps the
 * checked date — that is what it is for — so a guard on it would freeze each
 * row the moment it was first written and no re-run could ever correct
 * anything. `info_verified_at` is set by a person and by nothing else, so it is
 * the only one that can mean "hands off".
 *
 * ── PER-FIELD RULINGS ──
 *
 * `info_verified_at` is all-or-nothing: it freezes the whole row or none of
 * it, and a person who has checked one field has not checked thirteen. That is
 * too blunt for the commonest case there is — St Mary Magdalene, Elimbah,
 * whose Antiochian directory page gives "Coronation Street" with no street
 * number while the parish's own site has it. Freezing the row to protect the
 * address would also freeze the phone number, the website and the feast day,
 * none of which anybody has checked.
 *
 * So `opts.overrides` (the index from worker/lib/info-overrides.mjs) and
 * `opts.tier` (where THIS import reads) narrow REFRESHABLE per row: a field
 * pinned at a tier this import does not outrank is left out of that row's
 * DO UPDATE SET. A row with every refreshable field pinned gets DO NOTHING,
 * because `DO UPDATE SET` with an empty list is a syntax error and "update
 * nothing" is what it meant anyway.
 *
 * No overrides means the old list for every row, unchanged.
 */
const headFor = (r) => `INSERT INTO parishes (${COLUMNS.join(', ')}, info_verified_at) VALUES (\n`
  + `  ${COLUMNS.map((c) => (c === 'lat' || c === 'lng' ? r[c] : sql(r[c]))).join(', ')}, NULL)\n`;

/**
 * Does the row already carry a BETTER source than the one importing?
 *
 * `reconcile` hands every matched row its existing database row as `matched`,
 * so the incumbent's provenance is already here — no second query. The tier is
 * derived by the shared ladder, never re-derived locally, which is the whole
 * reason `sourceTier` is exported rather than reimplemented on this side.
 *
 * STRICTLY higher, and that asymmetry is the point. `outranks` refuses ties on
 * purpose — two sources at one tier disagreeing is not something a rank settles
 * — but applying that strictness HERE would be a catastrophe rather than a
 * scruple: a Greek re-run reads at `jurisdiction`, 281 of the 293 rows in
 * production were written by exactly such a run, and refusing a tie would
 * freeze every one of them at its first import with nothing saying why. A
 * directory re-reading its own rows is not a competing source; it is the same
 * source, later. So a tie refreshes exactly as it always did, and only an
 * incumbent ABOVE the importer holds.
 *
 * What that protects, concretely: a parish whose details were taken from its
 * own website (`info_source_type='website'` → `parish`) or typed by a person
 * (`'person'` → `admin`) is left entirely alone by a jurisdiction directory
 * scrape. A row still saying `import` against that directory's own URL is not,
 * and nothing about this run changes for it.
 *
 * This is the ROW-level guard and it is deliberately all-or-nothing, which
 * `info_verified_at` also is and per-field pins deliberately are not. The
 * difference is what each one means: a pin says "somebody decided this field",
 * so freezing its neighbours would overreach, while a better source describes
 * the WHOLE row — there is no coherent reading where a parish's own site is
 * authoritative for its phone number and its jurisdiction's directory is
 * authoritative for its address.
 *
 * `jurisdictionDirectory` is that jurisdiction's own directory URL, so a ref
 * pointing at it derives as `jurisdiction` rather than as a third-party
 * aggregator. Omitting it is safe — the ref then derives as `directory`, which
 * no importer is outranked by — but it is worth passing, because a row wrongly
 * read as `directory` is a row this guard will not protect.
 */
//
// ── A PARISH WITH A WEBSITE ──
//
// The incumbent is read with `governingTier`, not `sourceTier`: a parish that
// has a website of its own speaks at `parish` whatever filled the row in, so a
// jurisdiction directory re-read holds every such row and only the parishes
// with no site fall back to the directory. That is the owner's call, made
// knowing its cost: no script yet reads parish DETAILS off a parish website
// (the Greek site crawl reads service times), so a held row's address and
// phone now change by hand or not at all — and `heldFields` lists every one,
// so a run says what it declined rather than going quiet.
function outrankedByIncumbent(row, tier, jurisdictionDirectory) {
  const incumbent = row.matched ? governingTier(row.matched, jurisdictionDirectory) : null;
  return !!incumbent && outranks(incumbent, tier);
}

export function buildUpsert(rows, opts = {}) {
  if (rows.some((r) => !r.id)) throw new Error('every row needs an explicit id — run reconcile first');
  if (rows.some((r) => r.lat == null || r.lng == null)) throw new Error('lat and lng are NOT NULL in the schema');
  if (rows.some((r) => !r.timezone)) throw new Error('timezone must be derived from the address, never defaulted');

  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate id in batch: ${r.id}`);
    seen.add(r.id);
  }

  const { overrides = null, tier = 'jurisdiction', jurisdictionDirectory = null } = opts;
  return rows.map((r) => {
    if (outrankedByIncumbent(r, tier, jurisdictionDirectory)) {
      return `${headFor(r)}ON CONFLICT(id) DO NOTHING;`;
    }
    const held = overrides
      ? new Set(pinnedFields(overrides, r.id, tier).map((f) => f.field))
      : new Set();
    const refresh = REFRESHABLE.filter((c) => !held.has(c));
    const head = headFor(r);
    if (!refresh.length) {
      return `${head}ON CONFLICT(id) DO NOTHING;`;
    }
    return `${head}ON CONFLICT(id) DO UPDATE SET\n`
      + `  ${refresh.map((c) => `${c}=excluded.${c}`).join(', ')}\n`
      + 'WHERE parishes.info_verified_at IS NULL;';
  }).join('\n');
}

/**
 * What a run is about to leave alone because somebody ruled on it.
 *
 * Reported rather than inferred from the SQL: an import that quietly wrote
 * eleven of thirteen columns and said nothing is the failure mode this whole
 * mechanism exists to replace.
 */
export function heldFields(rows, { overrides = null, tier = 'jurisdiction', jurisdictionDirectory = null } = {}) {
  const out = [];
  for (const r of rows) {
    // The row-level hold reports first and reports EVERY refreshable column,
    // because that is literally what the DO NOTHING leaves alone. A run that
    // silently declined a whole parish would be worse than the per-field
    // silence this function was written to end, not better.
    if (outrankedByIncumbent(r, tier, jurisdictionDirectory)) {
      const incumbent = governingTier(r.matched, jurisdictionDirectory);
      out.push({
        id: r.id,
        name: r.name,
        whole_row: true,
        incumbent_tier: incumbent,
        held: REFRESHABLE.map((field) => ({ field, tier: incumbent, decision: 'outranked' })),
      });
      continue;
    }
    if (!overrides) continue;
    const held = pinnedFields(overrides, r.id, tier).filter((f) => REFRESHABLE.includes(f.field));
    if (held.length) out.push({ id: r.id, name: r.name, held });
  }
  return out;
}
