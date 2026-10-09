// Which parish a poster is from, and whether a venue is just the parish itself.
//
// Two questions the poster reader leaves half-answered, settled here by plain
// comparison rather than by asking the model again:
//
//   * A poster dropped at the wrong parish. The reader says so in its
//     `other_parish` (name and suburb, as printed); matchParish() turns that
//     into a parish on file, so the editor can offer to move the draft there in
//     one tap rather than leave the person to find it in a list of 293.
//
//   * A venue that is the parish's own address. The reader is told to leave
//     the venue empty at the parish's own church, and still writes
//     "86 Kenny St, Wollongong NSW" for St Elias, Wollongong — whose address is
//     86 Kenny Street — so the card reads as if it were somewhere else. And a
//     poster read at the wrong parish names the right one's address as the
//     venue, correctly, until the draft is moved there. isOwnVenue() catches
//     both.
//
// Addresses here are what the directories gave and people typed: "St" and
// "Street", "2a", "8/34" (unit 8, number 34), "12-14", a suburb with or without
// its comma, a church's name in front. A street address is compared as number
// and street; anything that will not parse as one simply does not match, which
// leaves the venue as the person or the reader wrote it.

const STREET_TYPES = {
  street: 'st', st: 'st', road: 'rd', rd: 'rd', avenue: 'ave', ave: 'ave', av: 'ave',
  parade: 'pde', pde: 'pde', highway: 'hwy', hwy: 'hwy', drive: 'dr', dr: 'dr',
  crescent: 'cres', cres: 'cres', place: 'pl', pl: 'pl', court: 'ct', ct: 'ct',
  lane: 'ln', ln: 'ln', terrace: 'tce', tce: 'tce', boulevard: 'blvd', blvd: 'blvd',
  circuit: 'cct', cct: 'cct', close: 'cl', cl: 'cl', grove: 'gr', gr: 'gr',
  square: 'sq', sq: 'sq', way: 'way', esplanade: 'esp', esp: 'esp', mews: 'mews',
  walk: 'walk', row: 'row', parkway: 'pkwy', pkwy: 'pkwy',
};
const TYPE_RE = Object.keys(STREET_TYPES).join('|');
// A number, maybe a second one after "-" (a range) or "/" (unit/number), then
// one to four words of street name, then the street's type. At least one word:
// "45 St Johns Rd" is St Johns Road, not a street called "St".
const STREET_RE = new RegExp(
  `(^|[^a-z0-9])(\\d+[a-z]?)(?:\\s*([-/])\\s*(\\d+[a-z]?))?\\s+((?:[a-z']+\\s+){1,4}?)(${TYPE_RE})(?![a-z])`);

// Not a place: states, countries and the words around them.
const NOT_PLACES = new Set(['nsw', 'vic', 'qld', 'sa', 'wa', 'tas', 'nt', 'act', 'n', 's', 'w', 'a',
  'new', 'south', 'wales', 'victoria', 'queensland', 'western', 'tasmania', 'northern', 'territory',
  'capital', 'australian', 'australia', 'zealand', 'nz']);
// Words that name a church without saying which one.
const STOP = ['st', 'saint', 'saints', 'sts', 'ss', 'the', 'of', 'and', 'our', 'a', 'in', 'at',
  'orthodox', 'church', 'parish', 'cathedral', 'chapel', 'community', 'monastery', 'convent', 'mission',
  'temple', 'greek', 'antiochian', 'russian', 'serbian', 'romanian', 'macedonian', 'ukrainian',
  'bulgarian', 'georgian', 'syrian', 'coptic', 'ethiopian', 'eritrean', 'armenian', 'christian',
  'archdiocese', 'diocese', 'metropolis'];
// Titles: "St Elias" and "Prophet Elias" are told apart by the suburb, not by
// the title — unless the title is the whole name, as in "The Archangels".
const TITLES = ['prophet', 'great', 'martyr', 'martyrs', 'apostle', 'apostles', 'archangel',
  'archangels', 'evangelist', 'archdeacon', 'theologian', 'most'];
const GENERIC = new Set([...STOP, ...TITLES]);
const STOP_SET = new Set(STOP);

/** Lower case, no accents, curly quotes straightened, "Mary's" -> "mary". */
function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[‘’ʼ]/g, "'").replace(/'s\b/g, '');
}

const words = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const placeWords = (s) => words(s).filter(w => !/^\d+$/.test(w) && !NOT_PLACES.has(w));
function distinctive(s) {
  const w = words(s).filter(x => !/^\d+$/.test(x));
  const named = w.filter(x => !GENERIC.has(x));
  return named.length ? named : w.filter(x => !STOP_SET.has(x));
}

/**
 * An address as number and street, with the suburb words after it and
 * whatever came in front of it ("Parish hall, ", "Religious Centre, ").
 * Null when there is no street number to go on — "Cnr Walker & Cooper
 * Streets" is a real address, and not one this can compare.
 */
export function streetKey(text) {
  const s = fold(text).replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  const m = s.match(STREET_RE);
  if (!m) return null;
  const [all, lead, first, sep, second, name, type] = m;
  const numbers = sep === '/' ? [second] : second ? [first, second] : [first];
  const at = m.index + lead.length;
  return {
    numbers: new Set(numbers),
    street: `${name.trim()} ${STREET_TYPES[type]}`.trim(),
    places: new Set(placeWords(s.slice(m.index + all.length))),
    prefix: s.slice(0, at),
  };
}

const meets = (a, b) => [...a].some(x => b.has(x));

function sameKey(a, b) {
  return meets(a.numbers, b.numbers) && a.street === b.street
    // A suburb on both sides has to agree; one side without it is not a disagreement.
    && (!a.places.size || !b.places.size || meets(a.places, b.places));
}

/** Do two addresses name the same street number? */
export function sameStreetAddress(a, b) {
  const ka = streetKey(a), kb = streetKey(b);
  return !!(ka && kb && sameKey(ka, kb));
}

/**
 * Is this venue only the parish's own address — nothing a card should show as
 * "held elsewhere"? The words in front of the number decide: "St Elias Church,
 * 86 Kenny St" names the parish itself, "Parish hall, 86 Kenny St" names a room
 * a visitor has to find, and the room stays.
 *
 * @param {string} venue
 * @param {{name: string, address: string}} parish
 */
export function isOwnVenue(venue, parish) {
  if (!venue || !parish || !parish.address) return false;
  if (words(venue).join(' ') === words(parish.address).join(' ')) return true;
  const v = streetKey(venue), own = streetKey(parish.address);
  if (!v || !own || !sameKey(v, own)) return false;
  const known = new Set([...GENERIC, ...words(parish.name), ...words(own.prefix)]);
  return words(v.prefix).every(w => known.has(w));
}

/** "St Elias, Wollongong" -> the dedication and the suburb ("Moonee Ponds (Ascot Vale)" keeps both). */
function splitName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf(',');
  return i < 0 ? { dedication: s, suburb: '' } : { dedication: s.slice(0, i), suburb: s.slice(i + 1) };
}

/**
 * The parish a poster says it is from, among those on file.
 *
 * Scored on three things, each a separate piece of evidence:
 *   the name — a word of the dedication that is not a title ("Elias")  +2
 *   the place — the suburb or town printed, found in the parish's name
 *     or address; with no place printed, the parish's suburb found in
 *     the printed name ("…Parish of Hobart")                           +2
 *   a venue — an event's venue at the parish's street address            +1
 * A parish needs two of them (3 points), and the clear lead: "St Nicholas"
 * alone is twenty parishes, and Wollongong has more than one church. Between
 * two that score alike, more of the name in common leads — Holy Cross and Holy
 * Dormition are both in Wollongong and both "Holy". A tie after that, or
 * nothing, is null — the editor then shows the name as printed and leaves the
 * choice to the person.
 *
 * @param {{name: string, place?: string}} other   what the reader printed
 * @param {string[]} venues                       the events' venues, as read
 * @param {Array<{id, name, address}>} parishes
 * @returns {string|null} a parish id
 */
export function matchParish(other, venues, parishes) {
  if (!other || (!other.name && !other.place)) return null;
  const wantName = distinctive(other.name);
  const wantPlace = placeWords(other.place);
  const nameWords = new Set(words(other.name));
  const scored = [];
  for (const p of parishes || []) {
    if (!p || !p.id || p.id === '_unassigned') continue;
    const { dedication, suburb } = splitName(p.name);
    let score = 0;
    const theirs = new Set(distinctive(dedication));
    const shared = new Set(wantName.filter(w => theirs.has(w))).size;
    if (shared) score += 2;
    const suburbWords = placeWords(suburb);
    if (wantPlace.length) {
      // The suburb in the name, and the one after the street in the address —
      // not the street's own words, or "Wollongong Rd" would be in Wollongong.
      const own = streetKey(p.address);
      const places = new Set([...suburbWords, ...(own ? own.places : placeWords(p.address))]);
      if (wantPlace.every(w => places.has(w))) score += 2;
    } else if (suburbWords.length && suburbWords.every(w => nameWords.has(w))) score += 2;
    if (p.address && (venues || []).some(v => v && sameStreetAddress(v, p.address))) score += 1;
    if (score) scored.push({ id: p.id, score, shared });
  }
  scored.sort((a, b) => b.score - a.score || b.shared - a.shared);
  const [top, next] = scored;
  if (!top || top.score < 3) return null;
  if (next && next.score === top.score && next.shared === top.shared) return null;
  return top.id;
}
