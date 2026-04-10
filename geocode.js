/**
 * Geocode an address string to { lat, lng } using OpenStreetMap Nominatim.
 * Free, no API key required. Rate limit: 1 req/sec (we add a small delay).
 * Returns null if geocoding fails.
 */
async function geocode(address) {
  if (!address || !address.trim()) return null;

  // Bias results toward Sydney, Australia
  const params = new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: 'au',
    viewbox: '150.5,-34.2,151.5,-33.4',
    bounded: '0'
  });

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'Agora-OrthodoxEventFinder/1.0' }
    });
    if (!res.ok) return null;

    const results = await res.json();
    if (!results.length) return null;

    return {
      lat: parseFloat(results[0].lat),
      lng: parseFloat(results[0].lon)
    };
  } catch (err) {
    console.error('[geocode] Failed:', err.message);
    return null;
  }
}

module.exports = { geocode };
