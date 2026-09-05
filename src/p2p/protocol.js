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
 * son identité applicative stable (`senderId`, distincte de l'ID de
 * transport Trystero — c'est elle qui permet de reconnaître le même
 * candidat d'une reconnexion à l'autre), son nom, un mot-clé de recherche
 * qu'il choisit lui-même (ex. "Data Engineer", "Python"), les mots-clés
 * extraits localement du CV, et une référence au fichier CV (transmis
 * séparément en binaire, voir p2p/trystero.js). Jamais de texte intégral
 * dans ce message — juste des mots-clés (§11, §51).
 *
 * Le `searchKeyword` sert de filtre grossier côté recruteur : une salle
 * d'annonce n'analyse une diffusion QUE si ce mot-clé correspond à l'un des
 * siens (voir p2p/discovery.js, `matchesKeywordGate`) — ça évite de
 * surcharger le recruteur avec des candidats hors sujet.
 */
export function createCandidateBroadcast({ senderId, displayName, searchKeyword, skills, domains, seniority, locations, languages, cvFileName }) {
  return {
    ...base(MessageType.CANDIDATE_BROADCAST),
    senderId: senderId || null,
    displayName: displayName || null,
    searchKeyword: searchKeyword || null,
    skills: skills || [],
    domains: domains || [],
    seniority: seniority || null,
    locations: locations || [],
    languages: languages || [],
    cvFileName: cvFileName || null,
  };
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
