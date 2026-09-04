// src/p2p/protocol.js
//
// Définit les types de messages échangés en P2P (§71) et leur construction.
// Toute réception passe par validateIncomingMessage (core/validation) avant
// d'être traitée — aucun message réseau n'est fiable par défaut (§55-56).

import { PROTOCOL_VERSION, PAYLOAD_LIMITS } from '../config/matching.js';

export const MessageType = Object.freeze({
  PEER_HELLO: 'peer_hello',
  PROFILE_ANNOUNCEMENT: 'profile_announcement',
  MATCH_PROPOSAL: 'match_proposal',
  CHAT_REQUEST: 'chat_request',
  CHAT_RESPONSE: 'chat_response',
  CHAT_MESSAGE: 'chat_message',
  PRESENCE_UPDATE: 'presence_update',
  THRESHOLD_UPDATE: 'threshold_update',
});

let counter = 0;
function nextId() {
  counter += 1;
  return `msg_${Date.now()}_${counter}`;
}

function base(type) {
  return { type, version: PROTOCOL_VERSION, id: nextId(), timestamp: Date.now() };
}

export function createPeerHello(peerId) {
  return { ...base(MessageType.PEER_HELLO), peerId };
}

/** Le `profile` doit déjà être un PeerProfile minimal (jamais un CV complet, §51). */
export function createProfileAnnouncement(profile) {
  return { ...base(MessageType.PROFILE_ANNOUNCEMENT), profile };
}

export function createMatchProposal({ toPeerId, matchScoreSummary }) {
  return { ...base(MessageType.MATCH_PROPOSAL), toPeerId, matchScoreSummary };
}

export function createChatRequest({ toPeerId, jobOrCandidateRef }) {
  return { ...base(MessageType.CHAT_REQUEST), toPeerId, jobOrCandidateRef };
}

export function createChatResponse({ toPeerId, requestId, accepted }) {
  return { ...base(MessageType.CHAT_RESPONSE), toPeerId, requestId, accepted };
}

export function createChatMessage({ toPeerId, text }) {
  return { ...base(MessageType.CHAT_MESSAGE), toPeerId, text: String(text).slice(0, 2000) };
}

export function createPresenceUpdate(status) {
  return { ...base(MessageType.PRESENCE_UPDATE), status };
}

/**
 * Diffusé par un recruteur quand il déplace le curseur de seuil d'une
 * annonce (§ nouveau : visibilité dynamique par score). Permet aux
 * candidats déjà connectés de mettre à jour la visibilité de cette
 * annonce sans attendre une nouvelle annonce Nostr complète.
 */
export function createThresholdUpdate({ postingId, threshold }) {
  return { ...base(MessageType.THRESHOLD_UPDATE), postingId, threshold };
}

/** Vérifie qu'un message ne dépasse pas la limite de taille appropriée à son type. */
export function limitForType(type) {
  if (type === MessageType.CHAT_MESSAGE) return PAYLOAD_LIMITS.maxChatMessageBytes;
  if (type === MessageType.PROFILE_ANNOUNCEMENT) return PAYLOAD_LIMITS.maxProfileBytes;
  return PAYLOAD_LIMITS.maxMessageBytes;
}
