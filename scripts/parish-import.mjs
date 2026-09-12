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
  'info_source_type', 'info_source_ref'];

// Columns a re-run may refresh. id and jurisdiction are identity; languages,
// color and info_verified_at are set by people, not by scrapes.
const REFRESHABLE = ['name', 'address', 'lat', 'lng', 'timezone', 'website',
  'phone', 'email', 'feast_day', 'info_source_ref'];

/**
 * The upsert, guarded so a re-run cannot undo human work.
 *
 * `DO UPDATE ... WHERE parishes.info_verified_at IS NULL` is the whole point:
 * re-geocoding a parish that already had a confirmed pin moved it 784m, so once
 * somebody checks a pin and stamps the row, a later scrape must leave it alone.
 * Rows arrive here with an explicit id — from `reconcile`, not from derivation.
 */
export function buildUpsert(rows) {
  if (rows.some((r) => !r.id)) throw new Error('every row needs an explicit id — run reconcile first');
  if (rows.some((r) => r.lat == null || r.lng == null)) throw new Error('lat and lng are NOT NULL in the schema');
  if (rows.some((r) => !r.timezone)) throw new Error('timezone must be derived from the address, never defaulted');

  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate id in batch: ${r.id}`);
    seen.add(r.id);
  }

  return rows.map((r) => (
    `INSERT INTO parishes (${COLUMNS.join(', ')}, info_verified_at) VALUES (\n` +
    `  ${COLUMNS.map((c) => (c === 'lat' || c === 'lng' ? r[c] : sql(r[c]))).join(', ')}, NULL)\n` +
    'ON CONFLICT(id) DO UPDATE SET\n' +
    `  ${REFRESHABLE.map((c) => `${c}=excluded.${c}`).join(', ')}\n` +
    'WHERE parishes.info_verified_at IS NULL;'
  )).join('\n');
}
