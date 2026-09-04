// src/core/normalization/normalize.js
//
// Normalisation déterministe (§23). N'invente jamais d'équivalence : se
// limite au dictionnaire SKILL_ALIASES + nettoyage de surface (casse,
// accents, espaces, singulier/pluriel simple).

import { SKILL_ALIASES } from '../../config/matching.js';

/**
 * Nettoie une chaîne : minuscule, sans accents, espaces compressés.
 * @param {string} value
 */
export function cleanToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/\s+/g, ' ');
}

/**
 * Normalise un intitulé de compétence via le dictionnaire d'alias.
 * Retourne aussi si une substitution a eu lieu (utile pour la provenance).
 * @param {string} raw
 * @returns {{ normalized: string, wasAliased: boolean }}
 */
export function normalizeSkill(raw) {
  const cleaned = cleanToken(raw);
  const singular = cleaned.endsWith('s') && cleaned.length > 3 ? cleaned.slice(0, -1) : cleaned;
  const alias = SKILL_ALIASES[cleaned] || SKILL_ALIASES[singular];
  return {
    normalized: alias || cleaned,
    wasAliased: Boolean(alias),
  };
}

/**
 * Normalise une liste de compétences en dédupliquant.
 * @param {string[]} skills
 * @returns {string[]}
 */
export function normalizeSkillList(skills = []) {
  const seen = new Set();
  const out = [];
  for (const s of skills) {
    const { normalized } = normalizeSkill(s);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Détermine si deux ensembles de compétences se recoupent, en renvoyant le
 * détail (intersection, manquantes) plutôt qu'un simple booléen — nécessaire
 * pour l'explicabilité (§29, §59).
 * @param {string[]} have
 * @param {string[]} required
 */
export function compareSkillSets(have, required) {
  const haveSet = new Set(normalizeSkillList(have));
  const reqNormalized = normalizeSkillList(required);
  const matched = [];
  const missing = [];
  for (const r of reqNormalized) {
    if (haveSet.has(r)) matched.push(r);
    else missing.push(r);
  }
  return { matched, missing, total: reqNormalized.length };
}
