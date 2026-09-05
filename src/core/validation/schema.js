// src/core/validation/schema.js
//
// Validation runtime légère (sans dépendance externe) des structures
// échangées : sorties WebLLM (§57, non utilisé dans le flux actuel mais
// conservé pour une intégration future) et messages réseau (§55, §56).
// Toute donnée reçue du réseau est non fiable par défaut.

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
 * Valide une diffusion candidat reçue du réseau (§11, §51) — c'est la SEULE
 * donnée publiée en P2P dans ce flux : les annonces du recruteur, elles, ne
 * quittent jamais son appareil.
 * Forme : { peerId, senderId?, displayName?, searchKeywords, skills, cities?, yearsOfExperience?, cvFileName? }
 * @param {unknown} broadcast
 */
export function validateCandidateBroadcast(broadcast) {
  const errors = [];
  if (typeof broadcast !== 'object' || broadcast === null) {
    return { ok: false, errors: ['diffusion non-objet.'] };
  }
  const b = /** @type {any} */ (broadcast);

  if (isString(b.fullText) || isString(b.cvText) || isString(b.rawDocument)) {
    errors.push('La diffusion ne doit jamais contenir le texte intégral d\'un document.');
  }
  if (b.senderId !== undefined && b.senderId !== null && (!isString(b.senderId) || b.senderId.length > 64)) {
    errors.push('senderId invalide.');
  }
  if (b.displayName !== undefined && b.displayName !== null) {
    if (!isString(b.displayName) || b.displayName.length > 80) errors.push('displayName doit être une chaîne de 80 caractères maximum.');
  }
  if (b.domain !== undefined && b.domain !== 'job' && b.domain !== 'dating') {
    errors.push('domain doit être "job" ou "dating".');
  }
  if (!isStringArray(b.searchKeywords) || b.searchKeywords.length === 0) {
    errors.push('searchKeywords est obligatoire (au moins un mot-clé, le candidat doit préciser ce qu\'il recherche).');
  } else if (b.searchKeywords.some((k) => typeof k !== 'string' || k.length > 60)) {
    errors.push('chaque searchKeywords doit faire 60 caractères maximum.');
  } else if (b.searchKeywords.length > 10) {
    errors.push('trop de mots-clés de recherche (10 maximum).');
  }
  if (b.skills !== undefined && !isStringArray(b.skills)) errors.push('skills invalide.');
  if (b.cities !== undefined) {
    if (!isStringArray(b.cities)) errors.push('cities invalide.');
    else if (b.cities.some((c) => c.length > 80)) errors.push('une ville dépasse 80 caractères.');
    else if (b.cities.length > 10) errors.push('trop de villes (10 maximum).');
  }
  if (b.countries !== undefined) {
    if (!isStringArray(b.countries)) errors.push('countries invalide.');
    else if (b.countries.some((c) => c.length > 80)) errors.push('un pays dépasse 80 caractères.');
    else if (b.countries.length > 10) errors.push('trop de pays (10 maximum).');
  }
  if (b.cvFileName !== undefined && b.cvFileName !== null && (!isString(b.cvFileName) || b.cvFileName.length > 200)) errors.push('cvFileName invalide.');
  if (b.yearsOfExperience !== undefined && b.yearsOfExperience !== null) {
    if (typeof b.yearsOfExperience !== 'number' || b.yearsOfExperience < 0 || b.yearsOfExperience > 80) errors.push('yearsOfExperience invalide.');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: b };
}
