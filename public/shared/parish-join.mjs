// Which parish fields a schedule rule borrows, and under what names.
//
// A rule owns its time, title, cadence, and two things that can differ from
// its parish: `location_override` (the Sunday it moves) and `languages`. Where
// either is null the parish's value is what shows — the projection reads the
// parish_* copy for that. Everything else here (name, pin, zone, colour,
// logo, website) is simply the parish's.
//
// On the wire /api/bundle sends each rule's OWN columns only, because the
// parish list travels in the same response: repeating twelve parish fields on
// every rule was a quarter of the bundle, and the website in particular is not
// a fact about a service. The browser puts them back with joinParish() before
// projecting, so project.mjs and merge.mjs see exactly the row shape they
// always have. The Worker's own projections (the admin write path, a deep link
// to one instance) still join in SQL, and build that SQL from this same list —
// one list, so the two joins cannot come to disagree about a name.

/** [parishes column, name it goes by on a rule] */
export const PARISH_JOIN = [
  ['lat', 'p_lat'],
  ['lng', 'p_lng'],
  ['timezone', 'p_timezone'],
  ['name', 'parish_name'],
  ['jurisdiction', 'parish_jurisdiction'],
  ['address', 'parish_address'],
  ['website', 'parish_website'],
  ['logo_path', 'parish_logo'],
  ['languages', 'parish_languages'],
  ['acronym', 'parish_acronym'],
  ['color', 'parish_color'],
  ['live_url', 'parish_live_url'],
];

/** The SELECT list the Worker joins with, `p` being the parishes alias. */
export const PARISH_JOIN_SQL = PARISH_JOIN.map(([col, as]) => `p.${col} AS ${as}`).join(', ');

/**
 * A rule with its parish's fields attached, as the SQL join would have given
 * it. A rule whose parish is not in the list (the placeholder parish is left
 * out of the bundle) gets nulls rather than undefined, which is what a LEFT
 * JOIN would say.
 */
export function joinParish(rule, parish) {
  const out = { ...rule };
  for (const [col, as] of PARISH_JOIN) out[as] = parish && parish[col] != null ? parish[col] : null;
  return out;
}

/** joinParish over a list, with the lookup built once. */
export function joinParishes(rules, parishes) {
  const byId = new Map((parishes || []).map(p => [p.id, p]));
  return (rules || []).map(r => joinParish(r, byId.get(r.parish_id)));
}
