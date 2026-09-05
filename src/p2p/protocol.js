// src/p2p/protocol.js
//
// Définit les types de messages échangés en P2P (§71) et leur construction.
// Toute réception passe par validateIncomingMessage (core/validation) avant
// d'être traitée — aucun message réseau n'est fiable par défaut (§55-56).
//
// Flux simplifié :
//   candidat  -> diffuse CANDIDATE_BROADCAST (nom + mots-clés) à tous
//   recruteur -> ne diffuse RIEN (ses annonces restent locales, jamais publiées)
//   recruteur -> envoie CHAT_REQUEST ou MEETING_PROPOSAL à un candidat précis
//   candidat  -> répond par CHAT_RESPONSE (accepté/refusé)
//   les deux  -> échangent des CHAT_MESSAGE une fois le canal ouvert

import { PROTOCOL_VERSION, PAYLOAD_LIMITS } from '../config/matching.js';

export const MessageType = Object.freeze({
  CANDIDATE_BROADCAST: 'candidate_broadcast',
  IDENTITY_RETIRED: 'identity_retired',
  CHAT_REQUEST: 'chat_request',
  MEETING_PROPOSAL: 'meeting_proposal',
  CHAT_RESPONSE: 'chat_response',
  CHAT_MESSAGE: 'chat_message',
});

let counter = 0;
function nextId() {
  counter += 1;
  return `msg_${Date.now()}_${counter}`;
}

function base(type) {
  return { type, version: PROTOCOL_VERSION, id: nextId(), timestamp: Date.now() };
}

/**
 * Diffusé par un candidat à tous les pairs connectés (recruteurs) :
 * son identité applicative stable (`senderId`), son nom, un mot-clé de
 * recherche (filtre côté recruteur, voir p2p/discovery.js), ses mots-clés
 * de CV (compétences+langues, sans catégorie — § simplification), sa ville
 * (champ explicite, comparée littéralement au texte de l'annonce, jamais
 * via une liste de villes), son ancienneté (explicite ou estimée à partir
 * de dates réelles du CV), et une référence au fichier CV en pièce jointe.
 * Jamais de texte intégral dans ce message (§11, §51).
 */
export function createCandidateBroadcast({ senderId, displayName, searchKeywords, skills, cities, yearsOfExperience, yearsOfExperienceEstimated, cvFileName }) {
  return {
    ...base(MessageType.CANDIDATE_BROADCAST),
    senderId: senderId || null,
    displayName: displayName || null,
    searchKeywords: searchKeywords || [],
    skills: skills || [],
    cities: cities || [],
    yearsOfExperience: typeof yearsOfExperience === 'number' ? yearsOfExperience : null,
    yearsOfExperienceEstimated: Boolean(yearsOfExperienceEstimated),
    cvFileName: cvFileName || null,
  };
}

/**
 * Diffusé quand un candidat "tue" son identité actuelle (§ ID compromis,
 * remis en question par l'utilisateur) : indique aux pairs déjà connectés
 * que `retiredId` ne représente plus personne, pour qu'ils retirent
 * immédiatement la ligne correspondante plutôt que d'attendre une
 * déconnexion réseau. Envoyé juste AVANT de rediffuser sous le nouvel ID.
 */
export function createIdentityRetired({ retiredId }) {
  return { ...base(MessageType.IDENTITY_RETIRED), retiredId: retiredId || null };
}

/** Le recruteur propose d'ouvrir un canal de discussion avec un candidat précis. */
export function createChatRequest({ toPeerId, roomTitle, fromName, fromId }) {
  return { ...base(MessageType.CHAT_REQUEST), toPeerId, roomTitle: roomTitle || null, fromName: fromName || null, fromId: fromId || null };
}

/** Le recruteur propose un rendez-vous (message libre : créneau, lien, etc.). */
export function createMeetingProposal({ toPeerId, roomTitle, note, fromName, fromId }) {
  return { ...base(MessageType.MEETING_PROPOSAL), toPeerId, roomTitle: roomTitle || null, note: String(note || '').slice(0, 500), fromName: fromName || null, fromId: fromId || null };
}

export function createChatResponse({ toPeerId, requestId, accepted }) {
  return { ...base(MessageType.CHAT_RESPONSE), toPeerId, requestId, accepted };
}

export function createChatMessage({ toPeerId, text }) {
  return { ...base(MessageType.CHAT_MESSAGE), toPeerId, text: String(text).slice(0, 2000) };
}

/** Vérifie qu'un message ne dépasse pas la limite de taille appropriée à son type. */
export function limitForType(type) {
  if (type === MessageType.CHAT_MESSAGE) return PAYLOAD_LIMITS.maxChatMessageBytes;
  if (type === MessageType.CANDIDATE_BROADCAST) return PAYLOAD_LIMITS.maxProfileBytes;
  return PAYLOAD_LIMITS.maxMessageBytes;
}
