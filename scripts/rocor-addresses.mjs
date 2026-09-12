// Street addresses for ROCOR parishes, read off the parish's own website.
//
// WHY THIS FILE EXISTS. The diocese's directory publishes a name, a suburb and
// a link, and 31 of its 39 links point at directory.stinnocentpress.com, the
// ROCOR-wide directory that used to carry each parish's address. Every one of
// those URLs now 404s and the directory root answers 403, so for most of these
// parishes there is no published address to scrape at all.
//
// What is left is each parish's own site, where one exists. Reading those is
// research, not scraping — a person opened the page and decided what the
// address was — and research that is not written down is research that has to
// be done again. The Greek run's is lost. This is the same class of work, kept.
//
// Every entry names where it came from, so a later reader can re-check it
// rather than trusting it. `note` records a disagreement between sources; it is
// never resolved silently.
//
// Keys are "<name> | <suburb>" exactly as the directory publishes them, so a
// directory edit drops the entry rather than silently attaching it to the wrong
// parish.

export const ADDRESSES = {
  'Sts. Peter and Paul Diocesan Cathedral | Strathfield': {
    address: '3-5 Vernon Street, Strathfield NSW 2135',
    source: 'https://rocor.org.au/saints-peter-and-paul-cathedral/',
  },
  'St. Nicholas Church | Wallsend': {
    address: '3 Irving Street, Wallsend NSW 2287',
    source: 'http://www.stnicholaswallsend.org.au/',
  },
  'St. Panteleimon Church | West Gosford': {
    // The site prints "NSW 2256"; West Gosford is 2250 and 2256 is Woy Woy, so
    // the postcode is left off rather than corrected or repeated.
    address: '7 Comserv Close, West Gosford NSW',
    source: 'http://www.gosfordrussianchurch.org.au/',
    note: 'parish site gives postcode 2256; West Gosford is 2250, so no postcode is recorded',
  },
  'Holy Virgin Protection Cathedral | East Brunswick': {
    address: '1-7 Albion Street, Brunswick East VIC 3057',
    source: 'https://www.pokrov.com.au/',
    note: 'OSM says 3-7 Albion Street and the diocesan calendar says 3 Albion St; the parish\'s own 1-7 is used',
  },
  'Church of Our Lady’s Dormition | Dandenong': {
    address: '1-3 Morwell Avenue, Dandenong VIC 3175',
    source: 'https://www.russianchurchindandenong.org/',
  },
  'Monastery of the Prophet Elias | Monarto South': {
    address: '272 Frahns Farm Road, Monarto South SA 5254',
    source: 'https://rocor.org.au/prophet-elias-monastery/',
    note: 'the diocesan page gives the street and the PO box but no number; 272 is from OSM, which misspells it "Frahns Farm Rpad"',
  },
  'St Elizabeth & Barbara Church | Woodcroft': {
    address: '2 Todd Street, Woodcroft SA 5162',
    source: 'https://www.sebo.church/',
    note: 'the site adds "enter via the Pimpala Road entrance"',
  },
  'St. Nicholas Church | Wayville': {
    address: '41-42 Greenhill Road, Wayville SA 5034',
    source: 'http://www.saintnicholasadelaide.org.au/',
  },
  'St. John the Forerunner Church | Canberra': {
    // The directory says "Canberra", which is the city. The parish is in
    // Narrabundah, and the suburb is what a map needs.
    address: '1 Matina Street, Narrabundah ACT 2604',
    source: 'http://www.stjohnthebaptist.org.au/',
    suburb: 'Narrabundah',
  },
  'Resurrection of Christ Church | Auckland': {
    address: '455-461 Dominion Road, Mount Eden, Auckland 1041',
    source: 'http://www.orthodox.net.nz/',
    suburb: 'Mount Eden',
  },
};

// OpenStreetMap objects identified by hand, where matching the directory's name
// against OSM's cannot work.
//
// OSM knows fifteen russian-denomination places of worship in Oceania. Ten of
// them carry their dedication in the name and the matcher finds those on its
// own. These four it cannot, and two of them it gets actively WRONG if left to
// guess, which is the reason this table exists rather than a cleverer heuristic:
//
//   - OSM names three of these buildings for their city rather than their saint
//     ("Geelong Russian Orthodox Church", "Warrnambool Orthodox Church", and
//     one in Adelaide tagged simply "Russian Orthodox"), so no token will ever
//     match the dedication the diocese publishes.
//   - Melbourne has TWO russian churches whose names contain "Protection of the
//     Holy Virgin", and the nearer one is not the cathedral. Matching on the
//     dedication picks the wrong building, 8km away, with every appearance of
//     confidence.
//
// The fifteenth, node/660911846 — "Holy Virgin's Protection", 41 Moore Street,
// Melbourne — is deliberately absent: it is not in the ROCOR directory at all,
// and it is the building the East Brunswick cathedral was being mismatched to.
// Leaving it unclaimed is the point.
export const OSM_PIN = {
  'Holy Virgin Protection Cathedral | East Brunswick': {
    osm: 'way/149818793',
    why: 'OSM calls the cathedral "The Russian Orthodox Most Holy Mother of God"; its 3-7 Albion Street matches the parish\'s own 1-7 Albion Street',
  },
  'Church of Icon of the Joy of All Who Sorrow | Bell Park': {
    osm: 'way/1178551760',
    why: 'tagged "Geelong Russian Orthodox Church"; sits in Bell Park, which is a Geelong suburb',
  },
  'Holy Fathers Community | Allansford': {
    osm: 'way/1110735022',
    why: 'tagged "Warrnambool Orthodox Church" but located at Allansford, 9km east of Warrnambool itself',
  },
  'St. Nicholas Church | Wayville': {
    osm: 'way/253923902',
    why: 'tagged only "Russian Orthodox"; 350m from the 41-42 Greenhill Road address the parish publishes',
  },
};

// Parishes where the World Orthodox Directory is out of date, and its address
// must not be used however confidently it is published.
export const IGNORE_WORLD_DIRECTORY = {
  'Sts. Cyril and Methodius Community / St Xenia Church | Tweed Heads': {
    why: 'the directory gives 114 Allied Dr, Arundel QLD, which is the community\'s '
      + 'former Gold Coast home. It has moved to South Tweed Heads, which is in NEW '
      + 'SOUTH WALES — a different timezone, with daylight saving. orthodoxyinaustralia.com '
      + 'records the move and the parish\'s own Facebook page reads "Gold Coast | Tweed '
      + 'Heads NSW". No street address is published for the new site, so it stays '
      + 'unplaced rather than pinned in the wrong state.',
  },
};

// Suburbs the directory names imprecisely. The directory groups by state and
// sometimes gives the city instead of the suburb, which is not wrong so much as
// too coarse for a pin — and for Tweed Heads it is wrong about the state, which
// matters because the state decides the timezone.
export const SUBURB_FIX = {
  'St. Nicholas Cathedral | Brisbane': {
    suburb: 'Woolloongabba',
    why: 'the diocese\'s own Internet Links page files this cathedral under Woolloongabba',
  },
  'Holy Dormition Church | Woollongong': {
    suburb: 'Wollongong',
    why: 'spelling; the directory doubles the l',
  },
};
