// geo.js — the two things Near actually needs: a real distance
// calculation, and a real (opt-in) browser geolocation request. Nothing
// here is faked — haversineDistanceKm is the standard great-circle
// formula, and requestGeolocation wraps the real navigator.geolocation
// API in a Promise, no polling, no simulated coordinates.

const EARTH_RADIUS_KM = 6371;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two lat/lon points, in kilometers. Real
// formula, not an approximation shortcut — accurate enough at any scale
// this app cares about (a few meters to thousands of km).
export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function isGeolocationAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

// A real, explicit permission prompt — the browser itself asks the person
// before this ever resolves. No coordinates are ever read without that.
export function requestGeolocation() {
  return new Promise((resolve, reject) => {
    if (!isGeolocationAvailable()) {
      reject(new Error('Geolocation is not available in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.message || 'Location permission denied')),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 }
    );
  });
}
