// src/p2p/protocol.js
//
// Definit les types de messages echanges en P2P et leur construction.
// Toute reception passe par validateIncomingMessage avant d'etre traitee.
//
// `domain` ('job' | 'dating') tague chaque diffusion/message pour que les
// differents modes cumules (candidat emploi, annonceur emploi, rencontre)
// partagent la meme connexion P2P sans se melanger.

import { PROTOCOL_VERSION, PAYLOAD_LIMITS } from '../config/matching.js';

export const MessageType = Object.freeze({
  CANDIDATE_BROADCAST: 'candidate_broadcast',
  IDENTITY_RETIRED: 'identity_retired',
  CHAT_REQUEST: 'chat_request',
  MEETING_PROPOSAL: 'meeting_proposal',
  CHAT_RESPONSE: 'chat_response',
  CHAT_MESSAGE: 'chat_message',
});

export const Domain = Object.freeze({ JOB: 'job', DATING: 'dating' });

let counter = 0;
function nextId() {
  counter += 1;
  return `msg_${Date.now()}_${counter}`;
}

function base(type) {
  return { type, version: PROTOCOL_VERSION, id: nextId(), timestamp: Date.now() };
}

export function createCandidateBroadcast({ domain = Domain.JOB, senderId, displayName, searchKeywords, skills, cities, countries, yearsOfExperience, yearsOfExperienceEstimated, cvFileName }) {
  return {
    ...base(MessageType.CANDIDATE_BROADCAST),
    domain,
    senderId: senderId || null,
    displayName: displayName || null,
    searchKeywords: searchKeywords || [],
    skills: skills || [],
    cities: cities || [],
    countries: countries || [],
    yearsOfExperience: typeof yearsOfExperience === 'number' ? yearsOfExperience : null,
    yearsOfExperienceEstimated: Boolean(yearsOfExperienceEstimated),
    cvFileName: cvFileName || null,
  };
}

export function createIdentityRetired({ domain = Domain.JOB, retiredId }) {
  return { ...base(MessageType.IDENTITY_RETIRED), domain, retiredId: retiredId || null };
}

export function createChatRequest({ domain = Domain.JOB, toPeerId, roomTitle, fromName, fromId }) {
  return { ...base(MessageType.CHAT_REQUEST), domain, toPeerId, roomTitle: roomTitle || null, fromName: fromName || null, fromId: fromId || null };
}

export function createMeetingProposal({ domain = Domain.JOB, toPeerId, roomTitle, note, fromName, fromId }) {
  return { ...base(MessageType.MEETING_PROPOSAL), domain, toPeerId, roomTitle: roomTitle || null, note: String(note || '').slice(0, 500), fromName: fromName || null, fromId: fromId || null };
}

export function createChatResponse({ domain = Domain.JOB, toPeerId, requestId, accepted }) {
  return { ...base(MessageType.CHAT_RESPONSE), domain, toPeerId, requestId, accepted };
}

export function createChatMessage({ domain = Domain.JOB, toPeerId, text }) {
  return { ...base(MessageType.CHAT_MESSAGE), domain, toPeerId, text: String(text).slice(0, 2000) };
}

export function limitForType(type) {
  if (type === MessageType.CHAT_MESSAGE) return PAYLOAD_LIMITS.maxChatMessageBytes;
  if (type === MessageType.CANDIDATE_BROADCAST) return PAYLOAD_LIMITS.maxProfileBytes;
  return PAYLOAD_LIMITS.maxMessageBytes;
}
