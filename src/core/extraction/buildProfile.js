// src/core/extraction/buildProfile.js
//
// Construit un CandidateProfile / JobProfile à partir des faits extraits.
// Volontairement plat (§ simplification demandée) : un seul sac de
// mots-clés normalisés par profil (compétences + langues confondues, sans
// catégorie), pas de domaine/séniorité/localisation devinés par liste.
//
// La ville et l'ancienneté minimale requise sont des champs EXPLICITES
// fournis par l'utilisateur (candidat : sa ville ; annonceur : l'ancienneté
// minimale recherchée) — jamais déduits d'une liste de mots-clés.

import { normalizeSkill, cleanToken } from '../normalization/normalize.js';

/**
 * Fusionne skill + language en un seul sac de mots-clés normalisés, dédupliqué.
 * @param {import('../validation/schema.js').ExtractedFact[]} facts
 * @param {import('../validation/schema.js').SemanticAnalysis|null} semantic
 */
function mergeKeywords(facts, semantic) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const { normalized } = normalizeSkill(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  };
  for (const f of facts.filter((f) => f.field === 'skill' || f.field === 'language')) add(f.value);
  if (semantic?.skills?.length) semantic.skills.forEach(add);
  if (semantic?.languages?.length) semantic.languages.forEach(add);
  return out;
}

/** Ancienneté du candidat : phrase explicite ("5 ans d'expérience") en priorité, sinon estimation via la date la plus ancienne trouvée dans le CV. */
function resolveYearsOfExperience(facts) {
  const explicit = facts.find((f) => f.field === 'years_of_experience');
  if (explicit) return { value: Number(explicit.value), estimated: false };
  const earliest = facts.find((f) => f.field === 'earliest_year_mention');
  if (earliest) {
    const years = new Date().getFullYear() - Number(earliest.value);
    if (years >= 0 && years <= 60) return { value: years, estimated: true };
  }
  return { value: null, estimated: false };
}

/** Découpe une saisie "Paris, Lyon" en liste de villes normalisées, dédupliquée. */
export function parseCommaList(raw) {
  return Array.from(new Set(String(raw || '').split(',').map((s) => cleanToken(s)).filter(Boolean)));
}

/**
 * @param {{ documentId: string, facts: import('../validation/schema.js').ExtractedFact[], semantic?: any, city?: string|null }} args
 */
export function buildCandidateProfile({ documentId, facts, semantic = null, city = null }) {
  const keywords = mergeKeywords(facts, semantic);
  const experience = resolveYearsOfExperience(facts);

  return {
    id: documentId,
    keywords,
    cities: parseCommaList(city),
    yearsOfExperience: experience.value,
    yearsOfExperienceEstimated: experience.estimated,
    generatedAt: Date.now(),
  };
}

/**
 * @param {{ documentId: string, facts: import('../validation/schema.js').ExtractedFact[], semantic?: any, rawText: string, minYearsRequired?: number|null }} args
 */
export function buildJobProfile({ documentId, facts, semantic = null, rawText, minYearsRequired = null }) {
  const keywords = mergeKeywords(facts, semantic);

  return {
    id: documentId,
    keywords,
    rawText: rawText || '',
    minYearsRequired: typeof minYearsRequired === 'number' ? minYearsRequired : null,
    generatedAt: Date.now(),
  };
}
