// Address -> { lat, lng } via OpenStreetMap Nominatim. Free, no key.
// Ported unchanged apart from being fetch-native; it already was.
//
// Nominatim asks for 1 req/sec and a real User-Agent. Admin edits are occasional
// and one-at-a-time, so no throttle is needed here.

export async function geocode(address, { countryCodes = 'au' } = {}) {
  if (!address || !address.trim()) return null;

  const params = new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: countryCodes,
    // Bias toward Sydney without excluding the rest of Oceania.
    viewbox: '150.5,-34.2,151.5,-33.4',
    bounded: '0',
  });

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'Agora-OrthodoxEventFinder/1.0 (orthodoxy.au)' },
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch (err) {
    console.error('[geocode] failed:', err.message);
    return null;
  }
}
