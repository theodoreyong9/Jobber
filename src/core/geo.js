// src/core/geo.js
//
// Utilitaire de geolocalisation, pour le mode Near. Aucune dependance
// externe, aucun geocodage de nom de ville : uniquement une distance entre
// deux coordonnees explicites (lat/lng), fournies volontairement par
// chaque participant qui choisit de se localiser.

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Distance a vol d'oiseau entre deux points, en kilometres (formule de
 * haversine). Renvoie null si une coordonnee manque.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}
