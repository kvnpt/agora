// Address -> { lat, lng } via OpenStreetMap Nominatim. Free, no key.
//
// Nominatim asks for 1 req/sec and a real User-Agent. Admin edits are occasional
// and one-at-a-time, so no throttle is needed here.

// The countries Agora covers. This is a HARD filter in Nominatim, not a
// preference: an address in a country missing from this list returns no result
// at all. It read 'au' until the first non-Australian parish was in sight,
// which would have failed silently — the address saves, the pin does not move,
// and nothing says why.
//
// Matches the basemap's bbox (110,-50,180,0) rather than "Oceania" loosely:
// Tonga and Samoa sit east of the antimeridian, so an address there would
// geocode onto a map that has no tiles for it. Add them here and to the bbox
// together, or not at all.
const OCEANIA = 'au,nz,pg,fj,nc,vu,sb';

export async function geocode(address, { countryCodes = OCEANIA } = {}) {
  if (!address || !address.trim()) return null;

  // No viewbox. This used to bias toward Sydney (150.5,-34.2,151.5,-33.4),
  // which was harmless while every parish was in Sydney and wrong the moment
  // one was not — Nominatim ranks by distance from it, and with limit=1 a
  // near-miss in Sydney can outrank the real answer in Clayton or Auckland.
  // Every seeded address carries a state and postcode, so it needs no help.
  const params = new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: countryCodes,
  });

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'Agora-OrthodoxEventFinder/1.0 (orthodoxy.au)' },
    });
    if (!res.ok) {
      console.error(`[geocode] ${res.status} for ${address}`);
      return null;
    }
    const results = await res.json();
    if (!results.length) {
      console.error(`[geocode] no match for ${address}`);
      return null;
    }
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch (err) {
    console.error('[geocode] failed:', err.message);
    return null;
  }
}
