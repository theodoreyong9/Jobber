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
// Filtre type ATS : mots vides (liaison) frequents en francais/anglais, a
// exclure des mots-cles retenus — un CV n'a pas besoin de retenir "et",
// "avec", "the", "and" comme mots-cles de comparaison. Volontairement une
// liste courte et generique (pas un dictionnaire linguistique complet).
const STOPWORDS = new Set([
  'et', 'ou', 'de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'au', 'aux',
  'a', 'en', 'dans', 'sur', 'sous', 'avec', 'sans', 'pour', 'par', 'entre',
  'ce', 'ces', 'cet', 'cette', 'que', 'qui', 'quoi', 'dont', 'ne', 'pas',
  'plus', 'moins', 'tres', 'peu', 'bien', 'aussi', 'ainsi', 'alors', 'donc',
  'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'without',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'a', 'an',
  'this', 'that', 'these', 'those', 'it', 'its',
]);

/** Vrai si le token ressemble a un mot-clé exploitable pour le matching (pas un mot de liaison, une longueur plausible). */
function isMeaningfulKeyword(token) {
  if (!token) return false;
  const bare = token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (STOPWORDS.has(bare)) return false;
  if (bare.length < 2 || bare.length > 40) return false;
  return true;
}

function mergeKeywords(facts, semantic) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const { normalized } = normalizeSkill(raw);
    if (normalized && isMeaningfulKeyword(normalized) && !seen.has(normalized)) {
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
 * @param {{ documentId: string, facts: import('../validation/schema.js').ExtractedFact[], semantic?: any, city?: string|null, country?: string|null }} args
 */
export function buildCandidateProfile({ documentId, facts, semantic = null, city = null, country = null }) {
  const keywords = mergeKeywords(facts, semantic);
  const experience = resolveYearsOfExperience(facts);

  return {
    id: documentId,
    keywords,
    cities: parseCommaList(city),
    countries: parseCommaList(country),
    yearsOfExperience: experience.value,
    yearsOfExperienceEstimated: experience.estimated,
    generatedAt: Date.now(),
  };
}

/**
 * @param {{ documentId: string, facts: import('../validation/schema.js').ExtractedFact[], semantic?: any, rawText: string, minYearsRequired?: number|null, maxYearsRequired?: number|null, country?: string|null, city?: string|null }} args
 */
export function buildJobProfile({ documentId, facts, semantic = null, rawText, minYearsRequired = null, maxYearsRequired = null, country = null, city = null }) {
  const keywords = mergeKeywords(facts, semantic);

  return {
    id: documentId,
    keywords,
    rawText: rawText || '',
    minYearsRequired: typeof minYearsRequired === 'number' ? minYearsRequired : null,
    maxYearsRequired: typeof maxYearsRequired === 'number' ? maxYearsRequired : null,
    country: country ? cleanToken(country) : null,
    city: city ? cleanToken(city) : null,
    generatedAt: Date.now(),
  };
}
