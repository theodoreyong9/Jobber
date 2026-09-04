// src/core/validation/schema.js
//
// Validation runtime légère (sans dépendance externe) des structures
// échangées : sorties WebLLM (§57) et messages réseau (§55, §56).
// Toute donnée reçue du réseau ou du modèle est non fiable par défaut.

/** @typedef {{ id: string, field: string, value: string, sourceDocumentId: string, sourceLocation?: string }} ExtractedFact */

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

function isString(v) { return typeof v === 'string'; }
function isStringArray(v) { return Array.isArray(v) && v.every(isString); }

/**
 * Valide la sortie structurée attendue de WebLLM pour l'analyse sémantique
 * (§57). Renvoie une version "assainie" (champs manquants -> valeurs par
 * défaut sûres) plutôt que de faire planter tout le pipeline.
 * @param {unknown} data
 * @returns {{ ok: true, value: SemanticAnalysis } | { ok: false, errors: string[] }}
 */
export function validateSemanticAnalysis(data) {
  const errors = [];
  if (typeof data !== 'object' || data === null) {
    return { ok: false, errors: ['La sortie du modèle n\'est pas un objet JSON.'] };
  }
  const d = /** @type {any} */ (data);

  if (d.skills !== undefined && !isStringArray(d.skills)) errors.push('skills doit être un tableau de chaînes.');
  if (d.domains !== undefined && !isStringArray(d.domains)) errors.push('domains doit être un tableau de chaînes.');
  if (d.responsibilities !== undefined && !isStringArray(d.responsibilities)) errors.push('responsibilities doit être un tableau de chaînes.');
  if (d.languages !== undefined && !isStringArray(d.languages)) errors.push('languages doit être un tableau de chaînes.');
  if (d.seniority !== undefined && d.seniority !== null && !isString(d.seniority)) errors.push('seniority doit être une chaîne ou null.');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      skills: d.skills ?? [],
      domains: d.domains ?? [],
      responsibilities: d.responsibilities ?? [],
      languages: d.languages ?? [],
      seniority: d.seniority ?? null,
    },
  };
}

/**
 * Valide un message P2P entrant avant tout traitement (§55, §56, §73).
 * Le champ `payload` reste toujours traité comme du contenu utilisateur,
 * jamais comme une instruction (voir prompts.js).
 * @param {unknown} raw
 * @param {number} maxBytes
 */
export function validateIncomingMessage(raw, maxBytes) {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['Message non-objet reçu du réseau.'] };
  }
  const size = new TextEncoder().encode(JSON.stringify(raw)).length;
  if (size > maxBytes) {
    return { ok: false, errors: [`Message trop volumineux (${size} > ${maxBytes} octets).`] };
  }
  const m = /** @type {any} */ (raw);
  const errors = [];
  if (!isString(m.type)) errors.push('type manquant ou invalide.');
  if (typeof m.version !== 'number') errors.push('version manquante ou invalide.');
  if (!isString(m.id)) errors.push('id manquant ou invalide.');
  if (typeof m.timestamp !== 'number') errors.push('timestamp manquant ou invalide.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: m };
}

/**
 * Valide un profil réseau minimal (§11, §51) avant diffusion.
 * @param {unknown} profile
 */
export function validatePeerProfile(profile) {
  const errors = [];
  if (typeof profile !== 'object' || profile === null) {
    return { ok: false, errors: ['profil non-objet.'] };
  }
  const p = /** @type {any} */ (profile);
  if (!isString(p.peerId)) errors.push('peerId manquant.');
  if (p.role !== 'candidate' && p.role !== 'recruiter') errors.push('role invalide.');
  if (typeof p.capabilities !== 'object' || p.capabilities === null) errors.push('capabilities manquant.');
  else {
    if (p.capabilities.skills !== undefined && !isStringArray(p.capabilities.skills)) errors.push('capabilities.skills invalide.');
    if (p.capabilities.domains !== undefined && !isStringArray(p.capabilities.domains)) errors.push('capabilities.domains invalide.');
  }
  // Interdiction explicite : un profil réseau ne doit jamais contenir de texte
  // intégral de document (§11, §51).
  if (isString(p.fullText) || isString(p.cvText) || isString(p.rawDocument)) {
    errors.push('Le profil réseau ne doit pas contenir de texte intégral de document.');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: p };
}
