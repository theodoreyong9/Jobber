// src/app/main.js
//
// Point d'entrée. Relie UI <-> core (parsing/scoring) <-> llm/provider
// (Worker WebLLM) <-> p2p (Nostr + Trystero) <-> storage (IndexedDB).
// Ce fichier reste un chef d'orchestre : la logique métier vit dans
// src/core, jamais ici.

import { parseDocument } from '../core/parser/documentParser.js';
import { extractFacts } from '../core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile } from '../core/extraction/buildProfile.js';
import { MATCH_CONFIG } from '../config/matching.js';

import * as llm from '../llm/provider.js';
import { MODEL_CATALOG, recommendModel } from '../models/catalog.js';

import { MatchingRanker, peerProfileToComparable } from '../p2p/discovery.js';
import { joinMatchingRoom } from '../p2p/trystero.js';
import { createLocalIdentity, subscribeToDiscovery, publishProfile, buildProfileEvent } from '../p2p/nostr.js';
import { MessageType, createProfileAnnouncement, createChatRequest, createChatResponse, createChatMessage } from '../p2p/protocol.js';

import * as profilesStore from '../storage/profiles.js';
import * as cacheStore from '../storage/cache.js';
import * as chatStore from '../storage/chat.js';
import * as blocklist from '../storage/blocklist.js';
import { wipeAllLocalData } from '../storage/idb.js';

import { renderRoleSelect, renderWorkspace, renderMatchList, renderMatchDetail, renderChat, renderLog, renderModelStatus } from '../ui/render.js';

const APP_ROOM_ID = 'jobmatch-p2p-v1';

/**
 * État applicatif en mémoire. Toute donnée sensible (CV brut) ne quitte
 * jamais cet état pour le réseau — seul un PeerProfile minimal est publié.
 */
const state = {
  role: null, // 'candidate' | 'recruiter'
  localProfile: null, // CandidateProfile | JobProfile
  identity: null,
  ranker: null,
  trystero: null,
  nostrSub: null,
  activeChatPeerId: null,
  webgpuAvailable: false,
};

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  renderLog(line);
  console.log(line);
}

async function init() {
  state.webgpuAvailable = await llm.detectWebGpuSupport();
  llm.onModelProgress((p) => renderModelStatus(p));

  const savedRole = await cacheStore.getCacheValue('role');
  if (savedRole) {
    await startWorkspace(savedRole);
  } else {
    renderRoleSelect(onRoleSelected);
  }
}

async function onRoleSelected(role) {
  await cacheStore.setCacheValue('role', role);
  await startWorkspace(role);
}

async function startWorkspace(role) {
  state.role = role;
  renderWorkspace({
    role,
    webgpuAvailable: state.webgpuAvailable,
    models: MODEL_CATALOG,
    onDocumentSubmit: handleDocumentSubmit,
    onLoadModel: handleLoadModel,
    onResetLocalData: handleResetLocalData,
  });
  log(`Mode ${role === 'candidate' ? 'candidat' : 'recruteur'} activé.`);
}

async function handleLoadModel(modelId) {
  log(`Chargement du modèle ${modelId}...`);
  try {
    await llm.loadModel(modelId);
    log('Modèle prêt.');
  } catch (e) {
    log(`Échec du chargement du modèle : ${e.message}. Le matching déterministe reste disponible.`);
  }
}

/**
 * @param {{ file?: File, text?: string, preferences?: any, useSemanticAnalysis: boolean }} input
 */
async function handleDocumentSubmit(input) {
  const kind = state.role === 'candidate' ? 'cv' : 'job';
  const documentId = `${kind}_${Date.now()}`;

  log('Analyse locale du document (CPU)...');
  let mammothLib = null;
  if (input.file?.name?.toLowerCase().endsWith('.docx')) {
    mammothLib = await import('mammoth').catch(() => null);
    if (!mammothLib) log('mammoth.js indisponible : impossible de lire ce .docx dans ce contexte.');
  }
  const doc = await parseDocument({ file: input.file, text: input.text, kind, id: documentId, mammothLib });
  const { facts } = extractFacts(doc);

  let semantic = null;
  if (input.useSemanticAnalysis) {
    log('Analyse sémantique WebLLM...');
    try {
      const result = await llm.analyzeDocument(kind, doc.rawText);
      semantic = result.value;
      if (result.usedFallback) log('WebLLM indisponible ou sortie invalide : repli sur extraction déterministe seule.');
    } catch (e) {
      log(`WebLLM indisponible (${e.message}) : repli sur extraction déterministe seule.`);
    }
  }

  const profile = kind === 'cv'
    ? buildCandidateProfile({ documentId, facts, semantic, preferences: input.preferences })
    : buildJobProfile({ documentId, facts, semantic, constraints: input.preferences?.constraints ?? [] });

  state.localProfile = profile;
  await profilesStore.saveProfile(profile);
  log('Profil de matching prêt (le document original reste local et inchangé).');

  await startNetwork();
}

async function startNetwork() {
  log('Connexion au réseau P2P...');
  state.blockedPeers = new Set((await blocklist.listBlockedPeers()).map((b) => b.peerId));
  state.ranker = new MatchingRanker(state.localProfile, state.role);
  state.ranker.onRankingChange((ranking) => renderMatchList(ranking, onOpenMatch));

  // --- Trystero : transport direct pour matching + chat ---
  try {
    const trysteroLib = await import('trystero/nostr');
    state.trystero = joinMatchingRoom(trysteroLib, { appId: APP_ROOM_ID }, APP_ROOM_ID);
    state.trystero.onMessage(handleIncomingMessage);
    state.trystero.onPeerJoin((peerId) => log(`Pair connecté : ${peerId.slice(0, 8)}…`));
    state.trystero.onPeerLeave((peerId) => {
      log(`Pair déconnecté : ${peerId.slice(0, 8)}…`);
      state.ranker.removePeer(peerId);
    });
  } catch (e) {
    log(`Trystero indisponible (${e.message}). Le matching reste local uniquement.`);
  }

  // --- Nostr : découverte + identité locale ---
  try {
    const nostrLib = await import('nostr-tools');
    state.identity = state.identity || createLocalIdentity(nostrLib);
    const peerProfile = toPeerProfile(state.localProfile, state.role, state.identity.publicKey);

    state.nostrSub = subscribeToDiscovery(nostrLib, (profile) => {
      if (state.blockedPeers.has(profile.peerId)) return; // (§75)
      state.ranker.ingestPeerProfile(profile.peerId, profile, peerProfileToComparable);
    });

    const pool = state.nostrSub.pool;
    await publishProfile(nostrLib, pool, state.identity, peerProfile);
    log('Profil minimal publié sur Nostr (le document original n\'est jamais publié).');
  } catch (e) {
    log(`Nostr indisponible (${e.message}). Découverte désactivée pour cette session.`);
  }
}

/** Construit le PeerProfile minimal partagé — jamais le document complet (§11, §51). */
function toPeerProfile(profile, role, peerId) {
  const isCandidate = role === 'candidate';
  return {
    peerId,
    role,
    capabilities: {
      skills: (isCandidate ? profile.skills : profile.requiredSkills).map((s) => s.name),
      domains: profile.domains ?? [],
      seniority: profile.seniority ?? undefined,
      locations: profile.locations ?? profile.preferences?.locations ?? [],
      languages: profile.languages ?? [],
    },
    updatedAt: Date.now(),
  };
}

function handleIncomingMessage(message, peerId) {
  if (state.blockedPeers?.has(peerId)) return; // pair bloqué : silence total (§75)

  switch (message.type) {
    case MessageType.PROFILE_ANNOUNCEMENT:
      state.ranker.ingestPeerProfile(peerId, message.profile, peerProfileToComparable);
      break;
    case MessageType.CHAT_REQUEST:
      log(`Proposition de chat reçue de ${peerId.slice(0, 8)}…`);
      renderChat.showIncomingRequest?.(peerId, message, (accepted) => respondToChatRequest(peerId, message, accepted), () => blockPeerFromUi(peerId));
      break;
    case MessageType.CHAT_RESPONSE:
      if (message.accepted) openChatThread(peerId, message.matchSummary);
      else log(`Chat refusé par ${peerId.slice(0, 8)}…`);
      break;
    case MessageType.CHAT_MESSAGE:
      chatStore.saveMessage({ id: message.id, peerId, senderId: peerId, timestamp: message.timestamp, text: message.text });
      renderChat.appendMessage(peerId, { senderId: peerId, text: message.text, timestamp: message.timestamp });
      break;
    default:
      break;
  }
}

function onOpenMatch(scoreEntry) {
  renderMatchDetail(scoreEntry, {
    onProposeChat: () => proposeChat(scoreEntry),
    onBlockPeer: () => blockPeerFromUi(scoreEntry.peerId),
    onIgnorePeer: () => ignorePeer(scoreEntry.peerId),
  });
}

/** Bloque un pair : supprime son profil du classement et coupe le canal (§75). */
async function blockPeerFromUi(peerId) {
  await blocklist.blockPeer(peerId);
  state.blockedPeers.add(peerId);
  state.ranker.removePeer(peerId);
  log(`Pair bloqué : ${peerId.slice(0, 8)}… (aucune notification envoyée au pair)`);
}

/** Ignore ponctuellement un pair sans le bloquer durablement : retire juste son profil courant. */
function ignorePeer(peerId) {
  state.ranker.removePeer(peerId);
  log(`Profil de ${peerId.slice(0, 8)}… retiré du classement pour cette session.`);
}

function proposeChat(scoreEntry) {
  const msg = createChatRequest({ toPeerId: scoreEntry.peerId, jobOrCandidateRef: state.localProfile.id });
  state.trystero?.send(msg, scoreEntry.peerId);
  log(`Proposition de chat envoyée à ${scoreEntry.peerId.slice(0, 8)}… (double consentement requis, §38)`);
}

function respondToChatRequest(peerId, requestMessage, accepted) {
  const response = createChatResponse({ toPeerId: peerId, requestId: requestMessage.id, accepted });
  state.trystero?.send(response, peerId);
  if (accepted) openChatThread(peerId, requestMessage.jobOrCandidateRef);
}

async function openChatThread(peerId, matchSummary) {
  state.activeChatPeerId = peerId;
  await chatStore.saveThread({ peerId, matchSummary, createdAt: Date.now(), active: true });
  const history = await chatStore.listMessagesForPeer(peerId);
  renderChat.open(peerId, history, (text) => sendChatMessage(peerId, text));
}

function sendChatMessage(peerId, text) {
  const msg = createChatMessage({ toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  renderChat.appendMessage(peerId, { senderId: 'me', text: msg.text, timestamp: msg.timestamp });
}

async function handleResetLocalData() {
  state.nostrSub?.close();
  state.trystero?.leave();
  await wipeAllLocalData();
  log('Toutes les données locales ont été supprimées (§54).');
  window.location.reload();
}

init();
