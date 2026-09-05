// src/core/matching/matchEngine.js
//
// Réduit d'abord la population via un filtre CPU bon marché avant tout
// scoring détaillé (§30-31).

/**
 * Filtre grossier : au moins un mot-clé en commun. Volontairement permissif
 * (peu de faux négatifs) car c'est juste un pré-filtre, pas le score final.
 * @param {import('../extraction/buildProfile.js').CandidateProfile} candidate
 * @param {import('../extraction/buildProfile.js').JobProfile} job
 */
export function passesCpuFilter(candidate, job) {
  if ((job.keywords ?? []).length === 0) return true; // rien à exiger : on ne filtre pas
  const candidateKeywords = new Set(candidate.keywords ?? []);
  return job.keywords.some((kw) => candidateKeywords.has(kw));
}
