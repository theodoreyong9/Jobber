// src/core/extraction/buildProfile.js
//
// Fusionne extraction heuristique (CPU) + analyse sémantique (WebLLM,
// optionnelle) en un CandidateProfile / JobProfile structuré (§20, §21).
// Chaque compétence garde sa provenance et son statut Explicit/Inferred
// (§69) plutôt que d'être aplatie en simple liste.

import { normalizeSkill, normalizeSkillList, cleanToken } from '../normalization/normalize.js';

/**
 * @typedef {{ name: string, provenance: 'explicit'|'inferred', sourceDocumentId: string, sourceLocation?: string }} SkillFact
 */

/**
 * @param {import('../validation/schema.js').ExtractedFact[]} facts
 * @param {import('../validation/schema.js').SemanticAnalysis|null} semantic
 * @param {string} documentId
 * @returns {SkillFact[]}
 */
function mergeSkills(facts, semantic, documentId) {
  const bySkill = new Map();

  for (const f of facts.filter((f) => f.field === 'skill')) {
    const { normalized } = normalizeSkill(f.value);
    if (!normalized) continue;
    bySkill.set(normalized, {
      name: normalized,
      provenance: 'explicit',
      sourceDocumentId: documentId,
      sourceLocation: f.sourceLocation,
    });
  }

  if (semantic?.skills?.length) {
    for (const raw of semantic.skills) {
      const { normalized } = normalizeSkill(raw);
      if (!normalized || bySkill.has(normalized)) continue;
      bySkill.set(normalized, {
        name: normalized,
        provenance: 'inferred',
        sourceDocumentId: documentId,
        sourceLocation: 'webllm:semantic_analysis',
      });
    }
  }

  return Array.from(bySkill.values());
}

function guessSeniority(facts, semantic) {
  if (semantic?.seniority) return { value: cleanToken(semantic.seniority), confidence: 'inferred' };
  const hint = facts.find((f) => f.field === 'seniority_hint');
  if (hint) return { value: hint.value, confidence: 'explicit' };
  return { value: null, confidence: 'unknown' };
}

/**
 * @param {{ documentId: string, facts: import('../validation/schema.js').ExtractedFact[], semantic?: any, preferences?: any }} args
 */
export function buildCandidateProfile({ documentId, facts, semantic = null, preferences = null }) {
  const skills = mergeSkills(facts, semantic, documentId);
  const domainsExplicit = facts.filter((f) => f.field === 'domain').map((f) => cleanToken(f.value));
  const domains = Array.from(new Set([...domainsExplicit, ...(semantic?.domains ?? []).map(cleanToken)]));
  const languages = Array.from(new Set([
    ...facts.filter((f) => f.field === 'language').map((f) => cleanToken(f.value)),
    ...(semantic?.languages ?? []).map(cleanToken),
  ]));
  const experiences = facts
    .filter((f) => f.field === 'experience_line')
    .map((f, i) => ({ id: `${documentId}_exp_${i}`, text: f.value, sourceLocation: f.sourceLocation }));
  const education = facts
    .filter((f) => f.field === 'education_line')
    .map((f, i) => ({ id: `${documentId}_edu_${i}`, text: f.value, sourceLocation: f.sourceLocation }));
  const yearsFact = facts.find((f) => f.field === 'years_of_experience');
  const seniority = guessSeniority(facts, semantic);

  return {
    id: documentId,
    skills,
    domains,
    languages,
    experiences,
    education,
    yearsOfExperience: yearsFact ? Number(yearsFact.value) : null,
    seniority: seniority.value,
    seniorityConfidence: seniority.confidence,
    preferences: preferences ?? null,
    generatedAt: Date.now(),
  };
}

/**
 * @param {{ documentId: string, facts: import('../validation/schema.js').ExtractedFact[], semantic?: any, constraints?: any[] }} args
 */
export function buildJobProfile({ documentId, facts, semantic = null, constraints = [] }) {
  const requiredSkills = mergeSkills(facts, semantic, documentId);
  const domainsExplicit = facts.filter((f) => f.field === 'domain').map((f) => cleanToken(f.value));
  const domains = Array.from(new Set([...domainsExplicit, ...(semantic?.domains ?? []).map(cleanToken)]));
  const languages = Array.from(new Set([
    ...facts.filter((f) => f.field === 'language').map((f) => cleanToken(f.value)),
    ...(semantic?.languages ?? []).map(cleanToken),
  ]));
  const responsibilities = semantic?.responsibilities?.length
    ? semantic.responsibilities
    : facts.filter((f) => f.field === 'experience_line').map((f) => f.value);
  const seniority = guessSeniority(facts, semantic);

  return {
    id: documentId,
    requiredSkills,
    preferredSkills: [],
    responsibilities,
    domains,
    languages,
    seniority: seniority.value,
    seniorityConfidence: seniority.confidence,
    locations: [],
    constraints,
    generatedAt: Date.now(),
  };
}

export { normalizeSkillList };
