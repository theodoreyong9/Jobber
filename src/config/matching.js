// src/config/matching.js
//
// Configuration centrale du matching. Toutes les pondérations, seuils et
// limites vivent ici — jamais dispersés dans le code (cf. cahier des
// charges §25, §60).

export const MATCH_WEIGHTS = Object.freeze({
  skills: 0.35,
  experience: 0.25,
  domain: 0.15,
  seniority: 0.10,
  location: 0.05,
  languages: 0.05,
  constraints: 0.05,
});

export const MATCH_CONFIG = Object.freeze({
  strongMatch: 85,
  goodMatch: 70,
  weakMatch: 50,
  semanticThreshold: 0.7, // similarité sémantique minimale pour considérer un lien CPU->WebLLM
});

// Séniorité ordonnée, utilisée pour calculer un score de distance plutôt
// qu'une simple égalité (junior vs senior ne doivent pas valoir 0 si proches).
export const SENIORITY_LEVELS = Object.freeze([
  'intern',
  'junior',
  'mid',
  'senior',
  'lead',
  'principal',
  'executive',
]);

// Limites réseau/anti-abus (cf. §73).
export const PAYLOAD_LIMITS = Object.freeze({
  maxProfileBytes: 8 * 1024,      // profil réseau minimal
  maxMessageBytes: 16 * 1024,     // message P2P générique
  maxChatMessageBytes: 4 * 1024,  // un message de chat
  maxDocumentBytes: 2 * 1024 * 1024, // CV/annonce uploadé localement (2 Mo)
});

// Dictionnaire de normalisation déterministe (CPU), volontairement modeste.
// WebLLM ne fait que désambiguïser les cas non couverts ici (§23).
export const SKILL_ALIASES = Object.freeze({
  'js': 'javascript',
  'ts': 'typescript',
  'pm': 'project management',
  'ml': 'machine learning',
  'ai': 'artificial intelligence',
  'k8s': 'kubernetes',
  'gcp': 'google cloud platform',
  'aws': 'amazon web services',
  'ci/cd': 'continuous integration',
  'nlp': 'natural language processing',
  'db': 'database',
  'ux': 'user experience',
  'ui': 'user interface',
  'qa': 'quality assurance',
});

export const PROTOCOL_VERSION = 1;
