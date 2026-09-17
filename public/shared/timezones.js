// The timezones an Agora parish can sit in, written down once.
//
// WHY THIS FILE EXISTS. `parishes.timezone` is what makes a recurrence rule's
// wall clock an instant — `start_time` is LOCAL, deliberately, so that a 9am
// liturgy stays 9am across a DST boundary. Get the zone wrong and every service
// at that parish is wrong, by an hour in Queensland and by three in Perth, and
// nothing about the row looks broken.
//
// Until now nothing offered the field at all. `POST /api/admin/parishes`
// defaulted it to Australia/Sydney and neither /admin form exposed it, so a
// parish added through the panel was silently Sydney forever. In production
// that default is wrong for 188 of 293 parishes.
//
// A CLOSED LIST FOR THE DROPDOWN, AN OPEN ONE FOR THE GUARD. This table is what
// /admin offers, and it covers the regions public/shared/locations.js declares.
// It is NOT what the Worker validates against — see isResolvableTimezone(). A
// closed allowlist in the API would reject Australia/Broken_Hill, or whichever
// zone the next parish genuinely needs, and the failure this guards is a typo
// rather than an unusual choice.
//
// Classic script rather than .mjs for the same reason as
// jurisdiction-colors.js: app.js is a classic script and the Worker bundles
// this through the CommonJS branch.
(function (root) {
  // Ordered by how many parishes are actually in each, so the common answer is
  // near the top of the menu rather than alphabetically buried.
  const PARISH_TIMEZONES = [
    { tz: 'Australia/Sydney',    label: 'Sydney',      note: 'NSW & ACT' },
    { tz: 'Australia/Melbourne', label: 'Melbourne',   note: 'VIC' },
    { tz: 'Australia/Adelaide',  label: 'Adelaide',    note: 'SA' },
    { tz: 'Australia/Brisbane',  label: 'Brisbane',    note: 'QLD — no daylight saving' },
    { tz: 'Pacific/Auckland',    label: 'Auckland',    note: 'New Zealand' },
    { tz: 'Australia/Perth',     label: 'Perth',       note: 'WA — no daylight saving' },
    { tz: 'Australia/Hobart',    label: 'Hobart',      note: 'TAS' },
    { tz: 'Australia/Darwin',    label: 'Darwin',      note: 'NT — no daylight saving' },
    { tz: 'Pacific/Fiji',        label: 'Fiji',        note: '' },
    { tz: 'Asia/Manila',         label: 'Manila',      note: 'Philippines' },
  ];

  // The historical default, and the reason this file exists. Kept as a named
  // thing rather than a literal so the places that still fall back to it are
  // greppable.
  const DEFAULT_TIMEZONE = 'Australia/Sydney';

  /**
   * A short name for a zone, for labelling a time field.
   *
   * "Start (Perth)" rather than "Start (Sydney)" on a Perth parish's service —
   * the schedule form used to say Sydney unconditionally, over a column the
   * schema documents as local to the PARISH's zone, which invites somebody to
   * convert a time that should have been typed as-is.
   *
   * Falls back to the last path segment so an unlisted-but-valid zone still
   * labels sensibly: 'America/New_York' reads as 'New York'.
   */
  function timezoneLabel(tz) {
    if (!tz) return '';
    const known = PARISH_TIMEZONES.find((z) => z.tz === tz);
    if (known) return known.label;
    return String(tz).split('/').pop().replace(/_/g, ' ');
  }

  /**
   * Does the runtime know this zone?
   *
   * The guard the API uses. Intl throws a RangeError on a zone it cannot
   * resolve, which catches the failure that actually happens — a typo, or a
   * UTC offset pasted in where an IANA name belongs — without pretending this
   * file knows every zone a parish could be in.
   */
  function isResolvableTimezone(tz) {
    if (typeof tz !== 'string' || !tz.trim()) return false;
    // A bare offset resolves in some runtimes and is never right here: it
    // cannot express daylight saving, which is the entire point of storing a
    // zone rather than an offset.
    if (!/^[A-Za-z]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$/.test(tz.trim())) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).format(0);
      return true;
    } catch {
      return false;
    }
  }

  const api = { PARISH_TIMEZONES, DEFAULT_TIMEZONE, timezoneLabel, isResolvableTimezone };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraTimezones = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
