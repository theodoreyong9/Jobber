// src/core/scoring/scoreEngine.js
//
// Calcule un MatchScore entre un CandidateProfile et un JobProfile.
// Le score EST le nombre de mots-cles en commun, point final - pas de
// dimensions ponderees. Ville, pays et anciennete sont des informations a
// cote du score, jamais melangees dedans.
//
// Deterministe pour des profils identiques. Aucun appel reseau ni LLM ici.

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

function compareCity(candidateCities, jobCity) {
  if (!jobCity) return 'unknown';
  if (!candidateCities || candidateCities.length === 0) return 'unknown';
  return candidateCities.includes(jobCity) ? 'match' : 'mismatch';
}

function compareCountry(candidateCountries, jobCountry) {
  if (!jobCountry) return 'unknown';
  if (!candidateCountries || candidateCountries.length === 0) return 'unknown';
  return candidateCountries.includes(jobCountry) ? 'match' : 'mismatch';
}

function compareExperience(candidateYears, minYearsRequired, maxYearsRequired) {
  if (minYearsRequired == null && maxYearsRequired == null) return 'unknown';
  if (candidateYears == null) return 'unknown';
  if (minYearsRequired != null && candidateYears < minYearsRequired) return 'below';
  if (maxYearsRequired != null && candidateYears > maxYearsRequired) return 'above';
  return 'match';
}

function formatRange(min, max) {
  if (min != null && max != null) return `entre ${min} et ${max} ans`;
  if (min != null) return `au moins ${min} an(s)`;
  return `au plus ${max} an(s)`;
}

export function computeMatchScore(candidate, job) {
  const { matched, missing } = compareKeywords(candidate.keywords, job.keywords);
  const cityStatus = compareCity(candidate.cities, job.city);
  const countryStatus = compareCountry(candidate.countries, job.country);
  const experienceStatus = compareExperience(candidate.yearsOfExperience, job.minYearsRequired, job.maxYearsRequired);

  const reasons = [];
  for (const kw of matched) reasons.push({ type: 'positive', label: kw });
  for (const kw of missing) reasons.push({ type: 'warning', label: kw });

  if (cityStatus === 'match') reasons.push({ type: 'positive', label: `Ville : ${job.city}` });
  else if (cityStatus === 'mismatch') reasons.push({ type: 'warning', label: `Ville(s) declaree(s) (${candidate.cities.join(', ')}) different de la ville de l'annonce (${job.city})` });

  if (countryStatus === 'match') reasons.push({ type: 'positive', label: `Pays : ${job.country}` });
  else if (countryStatus === 'mismatch') reasons.push({ type: 'warning', label: `Pays declare(s) (${candidate.countries.join(', ')}) different du pays de l'annonce (${job.country})` });

  const expNote = `${candidate.yearsOfExperience} an(s)${candidate.yearsOfExperienceEstimated ? ', estimee' : ''}`;
  if (experienceStatus === 'match') reasons.push({ type: 'positive', label: `Anciennete dans la fourchette (${expNote}, ${formatRange(job.minYearsRequired, job.maxYearsRequired)} requis)` });
  else if (experienceStatus === 'below') reasons.push({ type: 'warning', label: `Anciennete insuffisante (${expNote} < ${job.minYearsRequired} requis)` });
  else if (experienceStatus === 'above') reasons.push({ type: 'warning', label: `Anciennete superieure au maximum (${expNote} > ${job.maxYearsRequired} recherche)` });

  return {
    candidateId: candidate.id,
    jobId: job.id,
    matchedKeywords: matched,
    missingKeywords: missing,
    total: matched.length,
    totalRequired: job.keywords.length,
    cityStatus,
    countryStatus,
    experienceStatus,
    reasons,
  };
}

export function rankScores(scores) {
  return [...scores].sort((a, b) => b.total - a.total);
}
