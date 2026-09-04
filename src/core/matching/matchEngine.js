// src/core/matching/matchEngine.js
//
// Réduit d'abord la population via un filtre CPU bon marché avant tout
// scoring détaillé (§30-31). Le scoring sémantique complet (WebLLM) n'est
// jamais appelé sur l'intégralité du réseau — seulement sur les candidats
// pré-filtrés.

import { computeMatchScore, rankScores } from '../scoring/scoreEngine.js';

/**
 * Filtre grossier : au moins une compétence ou un domaine en commun.
 * Volontairement permissif (peu de faux négatifs) car c'est juste un
 * pré-filtre, pas le scoring final.
 * @param {import('../extraction/buildProfile.js').CandidateProfile} candidate
 * @param {import('../extraction/buildProfile.js').JobProfile} job
 */
export function passesCpuFilter(candidate, job) {
  const candidateSkills = new Set(candidate.skills.map((s) => s.name));
  const candidateDomains = new Set(candidate.domains ?? []);

  const hasSkillOverlap = (job.requiredSkills ?? []).some((s) => candidateSkills.has(s.name));
  const hasDomainOverlap = (job.domains ?? []).some((d) => candidateDomains.has(d));

  // Si l'annonce ne précise ni compétence ni domaine, on ne filtre pas
  // (on laisse le scoring sémantique trancher).
  if ((job.requiredSkills ?? []).length === 0 && (job.domains ?? []).length === 0) return true;

  return hasSkillOverlap || hasDomainOverlap;
}

/**
 * Pipeline complet : filtre CPU -> scoring -> classement (§46).
 * `semanticScorer` est optionnel : un hook pour affiner certains matchs
 * ambigus via WebLLM avant le scoring final (§30). Il doit renvoyer un
 * candidat/job profile éventuellement enrichi (jamais un texte réécrit).
 *
 * @param {import('../extraction/buildProfile.js').CandidateProfile} candidate
 * @param {import('../extraction/buildProfile.js').JobProfile[]} jobs
 * @param {{ semanticRefine?: (c: any, j: any) => Promise<{ candidate: any, job: any }> , semanticThreshold?: number }} [options]
 */
export async function matchCandidateAgainstJobs(candidate, jobs, options = {}) {
  const preFiltered = jobs.filter((job) => passesCpuFilter(candidate, job));

  const scored = [];
  for (const job of preFiltered) {
    let c = candidate;
    let j = job;

    // Un score ambigu (proche du seuil sémantique) peut justifier un appel
    // WebLLM ciblé — jamais systématique (§30).
    let preliminary = computeMatchScore(c, j);
    const ambiguous = preliminary.total >= 40 && preliminary.total <= 65;
    if (ambiguous && options.semanticRefine) {
      const refined = await options.semanticRefine(c, j);
      c = refined.candidate ?? c;
      j = refined.job ?? j;
      preliminary = computeMatchScore(c, j);
    }
    scored.push(preliminary);
  }

  return rankScores(scored);
}

/**
 * Symétrique côté recruteur : classe des candidats pour une annonce.
 * @param {import('../extraction/buildProfile.js').JobProfile} job
 * @param {import('../extraction/buildProfile.js').CandidateProfile[]} candidates
 */
export async function matchJobAgainstCandidates(job, candidates, options = {}) {
  const preFiltered = candidates.filter((c) => passesCpuFilter(c, job));
  const scored = [];
  for (const candidate of preFiltered) {
    let c = candidate;
    let j = job;
    let preliminary = computeMatchScore(c, j);
    const ambiguous = preliminary.total >= 40 && preliminary.total <= 65;
    if (ambiguous && options.semanticRefine) {
      const refined = await options.semanticRefine(c, j);
      c = refined.candidate ?? c;
      j = refined.job ?? j;
      preliminary = computeMatchScore(c, j);
    }
    scored.push(preliminary);
  }
  return rankScores(scored);
}
