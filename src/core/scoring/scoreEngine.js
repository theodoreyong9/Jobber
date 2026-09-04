// src/core/scoring/scoreEngine.js
//
// Calcule un MatchScore explicable entre un CandidateProfile et un
// JobProfile. Entièrement déterministe pour des profils identiques (§84).
// Aucun appel réseau ni LLM ici : cette étape consomme les profils déjà
// structurés (par l'extraction CPU + WebLLM en amont).

import { MATCH_WEIGHTS, SENIORITY_LEVELS } from '../../config/matching.js';
import { normalizeSkillList } from '../normalization/normalize.js';

/** UNKNOWN est une valeur de première classe, jamais assimilée à NO (§27, §58). */
export const TriState = Object.freeze({ YES: 'yes', NO: 'no', UNKNOWN: 'unknown' });

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

/**
 * Score des compétences : proportion des compétences requises couvertes,
 * en distinguant explicite/inféré pour la confiance globale.
 */
function scoreSkills(candidate, job) {
  const required = job.requiredSkills.map((s) => s.name);
  if (required.length === 0) {
    return { ratio: 1, matched: [], missing: [], reasons: [] };
  }
  const haveNames = new Set(candidate.skills.map((s) => s.name));
  const byName = new Map(candidate.skills.map((s) => [s.name, s]));

  const matched = [];
  const missing = [];
  for (const name of normalizeSkillList(required)) {
    if (haveNames.has(name)) matched.push(byName.get(name));
    else missing.push(name);
  }
  const ratio = matched.length / required.length;
  return { ratio, matched, missing };
}

/**
 * Score d'expérience : combine nombre d'années (si connu) et recoupement
 * texte des responsabilités vs expériences (heuristique simple, CPU only).
 */
function scoreExperience(candidate, job) {
  let years = null;
  if (typeof candidate.yearsOfExperience === 'number') {
    years = candidate.yearsOfExperience;
  }
  const seniorityIdx = SENIORITY_LEVELS.indexOf(candidate.seniority);
  const jobSeniorityIdx = SENIORITY_LEVELS.indexOf(job.seniority);

  if (years == null && seniorityIdx === -1) {
    return { ratio: 0.5, confidence: TriState.UNKNOWN }; // ni connu ni inconnu certain -> neutre
  }

  // Heuristique : proximité de séniorité si années absentes.
  if (years == null) {
    if (jobSeniorityIdx === -1) return { ratio: 0.6, confidence: TriState.UNKNOWN };
    const distance = Math.abs(seniorityIdx - jobSeniorityIdx);
    return { ratio: clamp01(1 - distance * 0.2), confidence: TriState.YES };
  }

  // Mapping approximatif années -> palier attendu.
  const expectedYearsBySeniority = { intern: 0, junior: 1, mid: 3, senior: 5, lead: 7, principal: 9, executive: 12 };
  const expected = expectedYearsBySeniority[job.seniority] ?? 3;
  const ratio = clamp01(1 - Math.abs(years - expected) / Math.max(expected, 3));
  return { ratio, confidence: TriState.YES };
}

function scoreDomain(candidate, job) {
  if (!job.domains?.length) return { ratio: 1, confidence: TriState.UNKNOWN };
  const have = new Set(candidate.domains ?? []);
  const overlap = job.domains.filter((d) => have.has(d));
  if (candidate.domains?.length === 0) return { ratio: 0.5, confidence: TriState.UNKNOWN };
  return { ratio: overlap.length / job.domains.length, confidence: TriState.YES };
}

function scoreSeniority(candidate, job) {
  const c = SENIORITY_LEVELS.indexOf(candidate.seniority);
  const j = SENIORITY_LEVELS.indexOf(job.seniority);
  if (c === -1 || j === -1) return { ratio: 0.5, confidence: TriState.UNKNOWN };
  const distance = Math.abs(c - j);
  return { ratio: clamp01(1 - distance * 0.25), confidence: TriState.YES };
}

function scoreLocation(candidate, job) {
  if (!job.locations?.length) return { ratio: 1, confidence: TriState.UNKNOWN };
  const have = new Set((candidate.locations ?? candidate.preferences?.locations ?? []));
  if (have.size === 0) return { ratio: 0.5, confidence: TriState.UNKNOWN };
  const overlap = job.locations.some((l) => have.has(l));
  return { ratio: overlap ? 1 : 0, confidence: TriState.YES };
}

function scoreLanguages(candidate, job) {
  if (!job.languages?.length) return { ratio: 1, confidence: TriState.UNKNOWN };
  const have = new Set(candidate.languages ?? []);
  if (have.size === 0) return { ratio: 0.5, confidence: TriState.UNKNOWN };
  const matchedCount = job.languages.filter((l) => have.has(l)).length;
  return { ratio: matchedCount / job.languages.length, confidence: TriState.YES };
}

/**
 * Évalue les hard constraints (§26). Une contrainte absente du CV n'est PAS
 * automatiquement un échec : elle est UNKNOWN sauf si `strict: true`.
 * @param {import('../extraction/buildProfile.js').JobProfile} job
 */
function evaluateHardConstraints(candidate, job) {
  const results = [];
  for (const c of job.constraints ?? []) {
    const haystack = new Set([
      ...candidate.skills.map((s) => s.name),
      ...(candidate.languages ?? []),
      ...(candidate.domains ?? []),
    ]);
    const present = haystack.has((c.value || '').toLowerCase());
    let status;
    if (present) status = TriState.YES;
    else if (c.strict) status = TriState.NO;
    else status = TriState.UNKNOWN;
    results.push({ constraint: c, status });
  }
  return results;
}

/**
 * Calcule le MatchScore complet entre un candidat et une annonce.
 * @param {import('../extraction/buildProfile.js').CandidateProfile} candidate
 * @param {import('../extraction/buildProfile.js').JobProfile} job
 * @returns {import('./types.js').MatchScore}
 */
export function computeMatchScore(candidate, job) {
  const skills = scoreSkills(candidate, job);
  const experience = scoreExperience(candidate, job);
  const domain = scoreDomain(candidate, job);
  const seniority = scoreSeniority(candidate, job);
  const location = scoreLocation(candidate, job);
  const languages = scoreLanguages(candidate, job);
  const hardConstraints = evaluateHardConstraints(candidate, job);

  const blocked = hardConstraints.some((r) => r.status === TriState.NO);

  const dimensionRatios = {
    skills: skills.ratio,
    experience: experience.ratio,
    domain: domain.ratio,
    seniority: seniority.ratio,
    location: location.ratio,
    languages: languages.ratio,
    constraints: blocked ? 0 : 1,
  };

  const dimensions = {};
  let total = 0;
  for (const [key, weight] of Object.entries(MATCH_WEIGHTS)) {
    const points = Math.round(dimensionRatios[key] * weight * 100);
    dimensions[key] = points;
    total += points;
  }
  if (blocked) total = Math.min(total, 20); // §26 : score plafonné, jamais compensé

  // Confiance globale : proportion de dimensions non-UNKNOWN.
  const confidenceFlags = [experience.confidence, domain.confidence, seniority.confidence, location.confidence, languages.confidence];
  const knownCount = confidenceFlags.filter((c) => c !== TriState.UNKNOWN).length;
  const confidence = Math.round((knownCount / confidenceFlags.length) * 100) / 100;

  const reasons = buildReasons({ skills, experience, domain, location, languages, hardConstraints });

  return {
    candidateId: candidate.id,
    jobId: job.id,
    total: Math.max(0, Math.min(100, total)),
    dimensions,
    hardConstraints,
    confidence,
    blocked,
    reasons,
  };
}

function buildReasons({ skills, hardConstraints }) {
  const reasons = [];
  for (const s of skills.matched) {
    reasons.push({ type: 'positive', label: s.name, provenance: s.provenance, sourceDocumentId: s.sourceDocumentId, sourceLocation: s.sourceLocation });
  }
  for (const m of skills.missing) {
    reasons.push({ type: 'warning', label: m, provenance: 'unknown' });
  }
  for (const r of hardConstraints) {
    if (r.status !== TriState.YES) {
      reasons.push({ type: r.status === TriState.NO ? 'blocking' : 'warning', label: `${r.constraint.label || r.constraint.value} (${r.status})` });
    }
  }
  return reasons;
}

/** Classe une liste de scores par ordre décroissant (§34-36). */
export function rankScores(scores) {
  return [...scores].sort((a, b) => b.total - a.total);
}
