// discovery.js — the cascade: never send everyone straight to expensive matching.
//
//   raw peers seen on the network
//        -> level 0: protocol/namespace compatibility
//        -> hard filters (can eliminate)
//        -> soft filters (can only reorder/prioritize)
//        -> budget cap
//        -> handed to matching.js

export const DEFAULT_BUDGETS = {
  maxDiscovered: 2000,
  maxPreFiltered: 500,
  maxForMatching: 100,
};

export function levelZero(peerMetas, myNamespace, protocolVersion) {
  return peerMetas.filter((p) => p.namespace === myNamespace && p.v === protocolVersion);
}

export function hardFilter(peers, constraints = {}) {
  return peers.filter((p) => {
    if (constraints.requiredRole && p.role !== constraints.requiredRole) return false;
    if (constraints.requiredLanguages && constraints.requiredLanguages.length) {
      const langs = p.languages || [];
      if (!constraints.requiredLanguages.some((l) => langs.includes(l))) return false;
    }
    if (constraints.maxDistanceKm != null && p.distanceKm != null) {
      if (p.distanceKm > constraints.maxDistanceKm) return false;
    }
    if (constraints.requireAvailableNow && !p.availableNow) return false;

    // Employment-style seniority range, checked in whichever direction
    // applies: a recruiter's declared range is checked against the peer's
    // earliest-CV-year; a candidate's own earliest year is checked against
    // the peer's declared range. Unknown dates are never used to eliminate.
    if (constraints.seniorityRange && p.earliestYear != null) {
      const { min, max } = constraints.seniorityRange;
      if (min != null && p.earliestYear < min) return false;
      if (max != null && p.earliestYear > max) return false;
    }
    if (constraints.myEarliestYear != null && (p.seniorityMin != null || p.seniorityMax != null)) {
      if (p.seniorityMin != null && constraints.myEarliestYear < p.seniorityMin) return false;
      if (p.seniorityMax != null && constraints.myEarliestYear > p.seniorityMax) return false;
    }

    // Same asymmetric pattern for Business/Independant: a declared rate
    // (supply side) checked against a declared budget range (demand side),
    // in whichever direction applies. Unknown values never eliminate.
    if (constraints.rateRange && p.rate != null) {
      const { min, max } = constraints.rateRange;
      if (min != null && p.rate < min) return false;
      if (max != null && p.rate > max) return false;
    }
    if (constraints.myRate != null && (p.budgetMin != null || p.budgetMax != null)) {
      if (p.budgetMin != null && constraints.myRate < p.budgetMin) return false;
      if (p.budgetMax != null && constraints.myRate > p.budgetMax) return false;
    }
    return true;
  });
}

export function softScore(peer, constraints = {}) {
  let s = 0;
  if (constraints.preferredCategory && peer.category === constraints.preferredCategory) s += 10;
  if (constraints.maxDistanceKm && peer.distanceKm != null) {
    s += Math.max(0, 10 - (peer.distanceKm / constraints.maxDistanceKm) * 10);
  }
  if (constraints.country && peer.country && constraints.country.toLowerCase() === peer.country.toLowerCase()) s += 6;
  if (constraints.city && peer.city && constraints.city.toLowerCase() === peer.city.toLowerCase()) s += 4;
  return s;
}

export function runCascade(peerMetas, opts) {
  const {
    myNamespace,
    protocolVersion,
    hardConstraints = {},
    softConstraints = {},
    budgets = DEFAULT_BUDGETS,
  } = opts;

  const stages = [];
  let pool = peerMetas.slice(0, budgets.maxDiscovered);
  stages.push({ label: 'Discovered on network', count: pool.length });

  pool = levelZero(pool, myNamespace, protocolVersion);
  stages.push({ label: 'Namespace / protocol match', count: pool.length });

  pool = hardFilter(pool, hardConstraints).slice(0, budgets.maxPreFiltered);
  stages.push({ label: 'Hard filters (location, language, availability)', count: pool.length });

  pool = pool
    .map((p) => ({ ...p, softScore: softScore(p, softConstraints) }))
    .sort((a, b) => b.softScore - a.softScore)
    .slice(0, budgets.maxForMatching);
  stages.push({ label: 'Soft-ranked, ready for matching', count: pool.length });

  return { pool, stages };
}
