// Who says so, and when we last looked: what a person's edit in /admin records.
//
// What survived of the source rulings (info_overrides, the tier ladder's write
// checks, per-field pins), which were retired for one setting per parish —
// `read_from`, in public/shared/read-from.js. This half is about DISPLAY: the
// sheet's "Updated today · Parish Contact" line.

/** What an edit in /admin records as its source, by who made it. */
export const ADMIN_SOURCE_NAME = 'Admin';
export const CONTACT_SOURCE_NAME = 'Parish Contact';

/**
 * The name an edit is recorded under.
 *
 * A parish contact speaks for the parish, which is the claim a reader cares
 * about — "Updated today · Parish Contact" says the parish itself said so. An
 * owner or editor is one of us, and says so.
 */
export function adminSourceName(role) {
  return role === 'parish' ? CONTACT_SOURCE_NAME : ADMIN_SOURCE_NAME;
}

/** The details a person's edit is a claim about. */
export const DETAIL_FIELDS = [
  'name', 'address', 'lat', 'lng', 'timezone', 'website', 'phone', 'email',
  'feast_day', 'acronym', 'languages', 'full_name',
];

const SOURCE_COLUMNS = ['info_source_type', 'info_source_name', 'info_source_ref'];

// '' and null are the same absence, a form posts '' for a field left empty, and
// lat/lng arrive as numbers from one client and strings from another.
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
function sameValue(field, a, b) {
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (field === 'lat' || field === 'lng') return Math.abs(Number(a) - Number(b)) < 1e-7;
  return String(a).trim() === String(b).trim();
}

/**
 * What a person saving a parish in /admin says about where the row came from.
 *
 * Both forms post EVERY field on every save, so presence proves nothing: the
 * details that changed are found by comparing against the stored row.
 *
 * A save that changes any detail is a claim by a person, so the row's source
 * becomes that person ("Admin", or "Parish Contact"; `info_source_type =
 * 'person'`) unless the same save set the source itself, and `info_checked_at`
 * becomes now unless they picked a different day. A save that changes only
 * the source still stamps the check; a save that changes neither — a colour,
 * a logo link — leaves the provenance alone.
 *
 * Whether imports may still write the parish is NOT decided here: that is
 * `read_from`, and the panel asks about it on the first hand edit.
 */
export function adminEditProvenance(stored, body, { now, sourceName = ADMIN_SOURCE_NAME } = {}) {
  const changed = DETAIL_FIELDS.filter((f) => body[f] !== undefined && !sameValue(f, body[f], stored[f]));
  const sourceSet = SOURCE_COLUMNS.some((f) => body[f] !== undefined && !sameValue(f, body[f], stored[f]));
  // A day picker cannot say what second somebody looked, so the same DAY is the
  // same check; /admin posts the bare date back even when nobody touched it.
  const day = (v) => (blank(v) ? '' : String(v).slice(0, 10));
  const checkedSet = body.info_checked_at !== undefined
    && day(body.info_checked_at) !== day(stored.info_checked_at);

  const sets = {};
  if (!changed.length && !sourceSet) {
    // Nothing about the details moved. Keep the stored timestamp rather than
    // letting a date-only echo round it down to midnight.
    if (body.info_checked_at !== undefined && !checkedSet) sets.info_checked_at = stored.info_checked_at;
    return { changed, sets };
  }
  if (changed.length && !sourceSet) {
    sets.info_source_type = 'person';
    sets.info_source_name = sourceName;
    // The old ref named the directory, and a person is not at a URL.
    sets.info_source_ref = null;
  }
  sets.info_checked_at = checkedSet ? body.info_checked_at : now;
  return { changed, sets };
}
