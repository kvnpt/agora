// Where a parish is, as a URL slug.
//
// /qld/greek and /greek/queensland both mean "Greek parishes in Queensland".
// Segments are unordered and compose with the jurisdiction, social, English
// and services segments already in the path — see detectUrlState in app.js.
//
// Same dual-mode wrapper as jurisdiction-colors.js: a classic script in the
// browser (app.js cannot import), CommonJS everywhere else, and the Worker
// bundles the CommonJS branch so the reserved-slug list it enforces on parish
// acronyms is literally this file rather than a copy of it.
//
// ── How a parish is matched ──────────────────────────────────────────────
//
// For a STATE the postal address decides, and the pin is the fallback. That
// looks backwards for something geographic, and it is the right way round
// here: 190 of production's 196 addresses name their state outright, the
// address is what the parish itself published, and the two borders that any
// box would get wrong (the Murray, and the Queensland line that runs between
// Coolangatta and Tweed Heads a kilometre apart) are exactly where a wrong
// answer would be noticed. Geometry then covers the handful with no address
// at all, and those are nowhere near a contested border.
//
// For a CITY and a COUNTRY the pin decides, because an address does not
// reliably name either — a Sydney parish's address says "Redfern NSW 2016".
(function (root) {

  // Australian state, from a postal address. Handles the dotted forms that
  // three of production's addresses use ("242 Cleveland St. Redfern N.S.W").
  const STATE_PATTERNS = {
    NSW: /\bN\.?\s?S\.?\s?W\.?\b|\bnew\s+south\s+wales\b/i,
    VIC: /\bV\.?\s?I\.?\s?C\.?(?:toria)?\b|\bvictoria\b/i,
    QLD: /\bQ\.?\s?L\.?\s?D\.?\b|\bqueensland\b/i,
    WA:  /\bW\.?\s?A\.?\b|\bwestern\s+australia\b/i,
    SA:  /\bS\.?\s?A\.?\b|\bsouth\s+australia\b/i,
    TAS: /\bT\.?\s?A\.?\s?S\.?\b|\btasmania\b/i,
    NT:  /\bN\.?\s?T\.?\b|\bnorthern\s+territory\b/i,
    ACT: /\bA\.?\s?C\.?\s?T\.?\b|\baustralian\s+capital\s+territory\b/i,
  };

  // Postcode ranges, as the second address signal. A postcode is unambiguous
  // where a bare "SA" in "SA Church Hall" is not.
  const POSTCODE_RANGES = [
    ['NSW', 1000, 2599], ['ACT', 2600, 2618], ['NSW', 2619, 2899],
    ['ACT', 2900, 2920], ['NSW', 2921, 2999],
    ['VIC', 3000, 3999], ['QLD', 4000, 4999], ['SA', 5000, 5799],
    ['WA', 6000, 6797], ['TAS', 7000, 7799], ['NT', 800, 899],
    ['VIC', 8000, 8999], ['QLD', 9000, 9999],
  ];

  // Order matters: the first pattern that hits wins, and a bare "WA" or "SA"
  // can appear in a street name, so the unambiguous long forms and the
  // postcode get a look first.
  function auStateFromAddress(address) {
    if (!address) return null;
    for (const [state, re] of Object.entries(STATE_PATTERNS)) {
      if (new RegExp(re.source.split('|').filter(s => /[a-z]{4}/.test(s)).join('|') || '(?!)', 'i').test(address)) {
        return state;
      }
    }
    // "… NSW 2016" / "… QLD 4870" — a 3-or-4 digit postcode near the end.
    const pc = /\b(\d{4})\b(?!.*\b\d{4}\b)/.exec(address);
    if (pc) {
      const n = Number(pc[1]);
      for (const [state, lo, hi] of POSTCODE_RANGES) if (n >= lo && n <= hi) return state;
    }
    for (const [state, re] of Object.entries(STATE_PATTERNS)) {
      if (re.test(address)) return state;
    }
    return null;
  }

  // ── Geometry fallback ──────────────────────────────────────────────────
  //
  // Rectangles, with the two borders no rectangle survives written as
  // piecewise-linear latitude-by-longitude. Coastlines are pushed offshore on
  // purpose: only the inter-state borders need to be right, and a coastline
  // drawn tight would leave a waterfront parish matching nothing.
  const lerpLat = (line, lng) => {
    if (lng <= line[0][0]) return line[0][1];
    if (lng >= line[line.length - 1][0]) return line[line.length - 1][1];
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1], [x1, y1] = line[i];
      if (lng <= x1) return y0 + (y1 - y0) * ((lng - x0) / (x1 - x0));
    }
    return line[line.length - 1][1];
  };

  // The Murray, west to east: SA corner, past Mildura and Robinvale, through
  // Albury (New South Wales, north bank) and Wodonga (Victoria, south bank),
  // out to Cape Howe. North of the line is New South Wales, south is Victoria.
  // Sampled closely enough that every parish production holds lands on the
  // side its own postal address says it does — see d1/locations.test.mjs.
  const MURRAY = [
    [140.97, -34.07], [141.50, -34.10], [142.00, -34.17], [142.50, -34.35],
    [142.90, -34.56], [143.30, -35.00], [143.60, -35.30], [144.10, -35.55],
    [144.60, -35.75], [145.20, -35.88], [146.00, -35.96], [146.92, -36.10],
    [147.50, -36.12], [148.00, -36.40], [148.50, -36.62], [149.00, -36.92],
    [149.98, -37.51],
  ];
  // Queensland's southern border: latitude 29°S out to the Dumaresq, then the
  // rivers and the Macpherson Range down to Point Danger. North is Queensland.
  //
  // The last three points are the coastal end, where the border is Boundary
  // Street: Coolangatta is Queensland and Tweed Heads is New South Wales, and
  // they are 1.3 km apart. Sampled finely enough to separate those two, which
  // is the limit worth reaching — a pin within ~200 m of this line is a coin
  // flip, and for a parish that close the postal address is what decides.
  const QLD_SOUTH = [
    [138.00, -26.00], [141.00, -29.00], [148.95, -29.00], [150.00, -28.70],
    [151.00, -28.90], [152.00, -28.50], [152.60, -28.36], [153.20, -28.30],
    [153.40, -28.22], [153.536, -28.1685], [153.552, -28.1625],
  ];

  /** Rough continental Australia, generously offshore. */
  function inAustralia(lat, lng) {
    if (lat == null || lng == null) return false;
    return lng >= 112 && lng <= 154.6 && lat <= -8.5 && lat >= -44.2;
  }

  function auStateFromPoint(lat, lng) {
    if (!inAustralia(lat, lng)) return null;
    // Canberra is an enclave, so it has to be asked about before New South Wales.
    // East edge at 149.21, not the 149.40 a loose box would use: Canberra
    // airport (149.19) is inside the Territory and Queanbeyan (149.24) is not.
    if (lng >= 148.76 && lng <= 149.21 && lat <= -35.12 && lat >= -35.93) return 'ACT';
    if (lat <= -39.2) return 'TAS';
    if (lng < 129.002) return 'WA';
    if (lng < 138.0) return lat > -26.0 ? 'NT' : 'SA';
    if (lng < 141.003 && lat <= -26.0) return 'SA';
    if (lat > lerpLat(QLD_SOUTH, lng)) return 'QLD';
    if (lng < 141.003) return 'SA';
    return lat > lerpLat(MURRAY, lng) ? 'NSW' : 'VIC';
  }

  function parishAuState(parish) {
    if (!parish) return null;
    // The pin settles the country before the address is allowed to name a
    // state. Postcodes are not globally unique: Auckland's 1041 sits in the
    // New South Wales range and Wellington's 6022 in the Western Australian
    // one, so a New Zealand parish would otherwise answer to /nsw and /wa.
    if (!inAustralia(parish.lat, parish.lng)) return null;
    return auStateFromAddress(parish.address) || auStateFromPoint(parish.lat, parish.lng);
  }

  const R_EARTH_KM = 6371;
  function distanceKm(lat1, lng1, lat2, lng2) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.sqrt(a));
  }

  // ── The registry ───────────────────────────────────────────────────────
  //
  // `slug` is what the URL is canonicalised to; `aliases` are the other
  // spellings that resolve to it, so /qld and /queensland are one filter and
  // the path always reads back as the short form.
  //
  // Three-letter city codes are IATA, because that is the abbreviation people
  // already know for an Australian city — SYD, MEL, BNE, PER, ADE — and it
  // gives an unarguable answer for the ones with no folk abbreviation (HBA,
  // CBR, DRW, OOL, CNS). Countries use ISO 3166-1 alpha-2.
  //
  // City radii are set so the metros do not swallow each other: Brisbane stops
  // short of the Gold Coast, Melbourne short of Geelong, Sydney short of
  // Wollongong and Newcastle. A parish outside every radius is still in its
  // state — the state filter is the one that covers the whole country.
  const LOCATIONS = [
    // ── Australian states and territories ──
    { slug: 'nsw', label: 'New South Wales', kind: 'state', auState: 'NSW',
      aliases: ['new-south-wales', 'newsouthwales'],
      bbox: [140.99, -37.51, 153.64, -28.15] },
    { slug: 'vic', label: 'Victoria', kind: 'state', auState: 'VIC',
      aliases: ['victoria'],
      bbox: [140.96, -39.20, 150.05, -33.98] },
    { slug: 'qld', label: 'Queensland', kind: 'state', auState: 'QLD',
      aliases: ['queensland'],
      bbox: [138.00, -29.20, 153.55, -9.14] },
    { slug: 'wa', label: 'Western Australia', kind: 'state', auState: 'WA',
      aliases: ['western-australia', 'westernaustralia'],
      bbox: [112.92, -35.14, 129.00, -13.69] },
    { slug: 'sa', label: 'South Australia', kind: 'state', auState: 'SA',
      aliases: ['south-australia', 'southaustralia'],
      bbox: [129.00, -38.06, 141.00, -25.99] },
    { slug: 'tas', label: 'Tasmania', kind: 'state', auState: 'TAS',
      aliases: ['tasmania'],
      bbox: [143.82, -43.65, 148.50, -39.57] },
    { slug: 'nt', label: 'Northern Territory', kind: 'state', auState: 'NT',
      aliases: ['northern-territory', 'northernterritory'],
      bbox: [129.00, -26.00, 138.00, -10.96] },
    { slug: 'act', label: 'Canberra', kind: 'state', auState: 'ACT',
      // The user-facing name is the city; the region is the territory. Both
      // spellings and the airport code resolve here.
      aliases: ['canberra', 'cbr', 'australian-capital-territory'],
      bbox: [148.76, -35.93, 149.21, -35.12] },

    // ── Australian cities ──
    { slug: 'syd', label: 'Sydney', kind: 'city', aliases: ['sydney'],
      center: [-33.8688, 151.2093], radiusKm: 65 },
    { slug: 'mel', label: 'Melbourne', kind: 'city', aliases: ['melbourne'],
      center: [-37.8136, 144.9631], radiusKm: 55 },
    { slug: 'bne', label: 'Brisbane', kind: 'city', aliases: ['brisbane'],
      center: [-27.4698, 153.0251], radiusKm: 50 },
    { slug: 'per', label: 'Perth', kind: 'city', aliases: ['perth'],
      center: [-31.9523, 115.8613], radiusKm: 60 },
    { slug: 'ade', label: 'Adelaide', kind: 'city', aliases: ['adelaide'],
      center: [-34.9285, 138.6007], radiusKm: 60 },
    { slug: 'hba', label: 'Hobart', kind: 'city', aliases: ['hobart'],
      center: [-42.8821, 147.3272], radiusKm: 45 },
    { slug: 'drw', label: 'Darwin', kind: 'city', aliases: ['darwin'],
      center: [-12.4634, 130.8456], radiusKm: 45 },
    { slug: 'ool', label: 'Gold Coast', kind: 'city', aliases: ['gold-coast', 'goldcoast'],
      center: [-28.0167, 153.4000], radiusKm: 35 },
    { slug: 'ntl', label: 'Newcastle', kind: 'city', aliases: ['newcastle'],
      center: [-32.9283, 151.7817], radiusKm: 40 },
    { slug: 'wol', label: 'Wollongong', kind: 'city', aliases: ['wollongong'],
      center: [-34.4248, 150.8931], radiusKm: 40 },
    { slug: 'gee', label: 'Geelong', kind: 'city', aliases: ['geelong'],
      center: [-38.1499, 144.3617], radiusKm: 35 },
    { slug: 'cns', label: 'Cairns', kind: 'city', aliases: ['cairns'],
      center: [-16.9186, 145.7781], radiusKm: 45 },
    { slug: 'tsv', label: 'Townsville', kind: 'city', aliases: ['townsville'],
      center: [-19.2590, 146.8169], radiusKm: 45 },

    // ── Countries and their cities ──
    { slug: 'nz', label: 'New Zealand', kind: 'country', aliases: ['new-zealand', 'newzealand', 'aotearoa'],
      bbox: [166.0, -47.60, 179.10, -34.10] },
    { slug: 'akl', label: 'Auckland', kind: 'city', aliases: ['auckland'],
      center: [-36.8485, 174.7633], radiusKm: 55 },
    { slug: 'wlg', label: 'Wellington', kind: 'city', aliases: ['wellington'],
      center: [-41.2866, 174.7756], radiusKm: 40 },
    { slug: 'chc', label: 'Christchurch', kind: 'city', aliases: ['christchurch'],
      center: [-43.5321, 172.6362], radiusKm: 40 },
    { slug: 'dud', label: 'Dunedin', kind: 'city', aliases: ['dunedin'],
      center: [-45.8788, 170.5028], radiusKm: 40 },
    { slug: 'fj', label: 'Fiji', kind: 'country', aliases: ['fiji'],
      bbox: [176.80, -21.00, -178.20, -12.40] },
    // 'ph' is ISO 3166-1 alpha-2, and it is what to use over "filo": that is a
    // demonym for the people, not a code for the country, and it reads as
    // pastry. 'phl' (alpha-3) and the full names resolve here too.
    { slug: 'ph', label: 'Philippines', kind: 'country',
      aliases: ['phl', 'philippines', 'pilipinas'],
      bbox: [116.00, 4.20, 127.00, 21.30] },
  ];

  const BY_SLUG = new Map();
  for (const loc of LOCATIONS) {
    BY_SLUG.set(loc.slug, loc);
    for (const a of loc.aliases || []) BY_SLUG.set(a, loc);
  }

  /** Every spelling that resolves to a location. Reserved against acronyms. */
  const LOCATION_SLUGS = new Set(BY_SLUG.keys());

  const normSlug = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');

  /** Slug or alias, in any spelling, to the location it names. */
  function resolveLocation(slug) {
    const key = normSlug(slug);
    return BY_SLUG.get(key) || BY_SLUG.get(key.replace(/-/g, '')) || null;
  }

  // Fiji straddles the antimeridian, so its "west" is greater than its "east"
  // and the longitude test has to wrap.
  function inBbox(bbox, lat, lng) {
    if (lat == null || lng == null) return false;
    const [w, s, e, n] = bbox;
    if (lat < s || lat > n) return false;
    return w <= e ? (lng >= w && lng <= e) : (lng >= w || lng <= e);
  }

  function locationMatchesParish(loc, parish) {
    if (!loc || !parish) return false;
    if (loc.kind === 'state') return parishAuState(parish) === loc.auState;
    if (loc.kind === 'city') {
      if (parish.lat == null || parish.lng == null) return false;
      return distanceKm(parish.lat, parish.lng, loc.center[0], loc.center[1]) <= loc.radiusKm;
    }
    return inBbox(loc.bbox, parish.lat, parish.lng);
  }

  /** [west, south, east, north] to frame when the filter is applied. */
  function locationBbox(loc) {
    if (!loc) return null;
    if (loc.bbox) return loc.bbox;
    // A city is a centre and a radius; turn it into a box. One degree of
    // latitude is ~111km everywhere; longitude shrinks with the cosine.
    const [lat, lng] = loc.center;
    const dLat = loc.radiusKm / 111;
    const dLng = loc.radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }

  const api = {
    LOCATIONS, LOCATION_SLUGS,
    resolveLocation, locationMatchesParish, locationBbox,
    parishAuState, auStateFromAddress, auStateFromPoint, inAustralia,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraLocations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
