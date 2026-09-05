// src/config/matching.js
//
// Configuration centrale. Le scoring lui-même n'a plus de pondérations par
// catégorie (§ simplification demandée : le score CPU est un simple compte
// de mots-clés en commun, extraits des deux côtés — pas de dimensions
// pondérées comme domaine/séniorité/langues). Ce fichier ne garde donc que
// les limites réseau/anti-abus et la normalisation des mots-clés.

// Limites réseau/anti-abus (cf. §73).
export const PAYLOAD_LIMITS = Object.freeze({
  maxProfileBytes: 16 * 1024,     // profil réseau minimal (plusieurs annonces possibles côté recruteur)
  maxMessageBytes: 16 * 1024,     // message P2P générique
  maxChatMessageBytes: 4 * 1024,  // un message de chat
  maxDocumentBytes: 2 * 1024 * 1024, // CV/annonce uploadé localement (2 Mo)
});

/** Nombre maximal de salles d'annonce actives simultanément par recruteur (anti-abus, §73). */
export const MAX_POSTINGS_PER_RECRUITER = 20;

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
