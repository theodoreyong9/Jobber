// src/core/scoring/scoreEngine.js
//
// Calcule un MatchScore entre un CandidateProfile et un JobProfile.
// Simplification demandee : le score EST le nombre de mots-cles en
// commun, point final - pas de dimensions ponderees (domaine, seniorite,
// langues, localisation...) qui donnent l'illusion d'un calcul plus riche
// qu'il ne l'est. La ville et l'anciennete sont des informations a cote du
// score, jamais melangees dedans.
//
// Deterministe pour des profils identiques. Aucun appel reseau ni LLM
// ici : cette etape consomme des profils deja construits.

function compareKeywords(candidateKeywords, requiredKeywords) {
  const have = new Set(candidateKeywords);
  const matched = [];
  const missing = [];
  for (const kw of requiredKeywords) {
    if (have.has(kw)) matched.push(kw);
    else missing.push(kw);
  }
  return { matched, missing };
}

function compareCity(candidateCity, jobRawText) {
  if (!candidateCity) return 'unknown';
  const haystack = (jobRawText || '').toLowerCase();
  return haystack.includes(candidateCity) ? 'match' : 'mismatch';
}

function compareExperience(candidateYears, minYearsRequired) {
  if (minYearsRequired == null) return 'unknown';
  if (candidateYears == null) return 'unknown';
  return candidateYears >= minYearsRequired ? 'match' : 'below';
}

export function computeMatchScore(candidate, job) {
  const { matched, missing } = compareKeywords(candidate.keywords, job.keywords);
  const cityStatus = compareCity(candidate.city, job.rawText);
  const experienceStatus = compareExperience(candidate.yearsOfExperience, job.minYearsRequired);

  const reasons = [];
  for (const kw of matched) reasons.push({ type: 'positive', label: kw });
  for (const kw of missing) reasons.push({ type: 'warning', label: kw });
  if (cityStatus === 'match') reasons.push({ type: 'positive', label: `Ville : ${candidate.city}` });
  else if (cityStatus === 'mismatch') reasons.push({ type: 'warning', label: `Ville declaree (${candidate.city}) non mentionnee dans l'annonce` });
  if (experienceStatus === 'match') reasons.push({ type: 'positive', label: `Anciennete suffisante (${candidate.yearsOfExperience} an(s)${candidate.yearsOfExperienceEstimated ? ', estimee' : ''} >= ${job.minYearsRequired} requis)` });
  else if (experienceStatus === 'below') reasons.push({ type: 'warning', label: `Anciennete insuffisante (${candidate.yearsOfExperience} an(s)${candidate.yearsOfExperienceEstimated ? ', estimee' : ''} < ${job.minYearsRequired} requis)` });

  return {
    candidateId: candidate.id,
    jobId: job.id,
    matchedKeywords: matched,
    missingKeywords: missing,
    total: matched.length,
    totalRequired: job.keywords.length,
    cityStatus,
    experienceStatus,
    reasons,
  };
}

export function rankScores(scores) {
  return [...scores].sort((a, b) => b.total - a.total);
}
