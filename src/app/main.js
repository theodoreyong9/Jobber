// src/app/main.js
//
// Point d'entrée. Relie UI <-> core (parsing/scoring) <-> llm/provider
// (Worker WebLLM) <-> p2p (Nostr + Trystero) <-> storage (IndexedDB).
// Ce fichier reste un chef d'orchestre : la logique métier vit dans
// src/core, jamais ici.

import { parseDocument } from '../core/parser/documentParser.js';
import { extractFacts } from '../core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile } from '../core/extraction/buildProfile.js';
import { DEFAULT_VISIBILITY_THRESHOLD, MAX_POSTINGS_PER_RECRUITER } from '../config/matching.js';

import * as llm from '../llm/provider.js';
import { MODEL_CATALOG } from '../models/catalog.js';

import { MatchingRanker } from '../p2p/discovery.js';
import { joinMatchingRoom } from '../p2p/trystero.js';
import { createLocalIdentity, subscribeToDiscovery, publishProfile } from '../p2p/nostr.js';
import { MessageType, createChatRequest, createChatResponse, createChatMessage, createThresholdUpdate } from '../p2p/protocol.js';

import * as profilesStore from '../storage/profiles.js';
import * as cacheStore from '../storage/cache.js';
import * as chatStore from '../storage/chat.js';
import * as blocklist from '../storage/blocklist.js';
import { wipeAllLocalData } from '../storage/idb.js';

import {
  renderRoleSelect, renderCandidateWorkspace, renderRecruiterWorkspace, renderPostingsList,
  renderMatchList, renderMatchDetail, renderChat, renderLog, renderModelStatus,
} from '../ui/render.js';

const APP_ROOM_ID = 'jobmatch-p2p-v1';
const THRESHOLD_PUBLISH_DEBOUNCE_MS = 800;

/** État applicatif en mémoire. Le CV/annonce brut ne quitte jamais cet état. */
const state = {
  role: null, // 'candidate' | 'recruiter'
  identity: null,
  trystero: null,
  nostrSub: null,
  nostrLib: null,
  nostrPool: null,
  blockedPeers: new Set(),
  webgpuAvailable: false,
  displayName: null,

  // --- mode candidat ---
  localProfile: null, // CandidateProfile
  ranker: null,       // MatchingRanker (role='candidate')

  // --- mode recruteur ---
  /** @type {Map<string, { id: string, title: string, profile: any, threshold: number, ranker: MatchingRanker }>} */
  postings: new Map(),
};

let publishTimer = null;

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  renderLog(line);
  console.log(line);
}

async function init() {
  state.webgpuAvailable = await llm.detectWebGpuSupport();
  llm.onModelProgress((p) => renderModelStatus(p));

  const savedRole = await cacheStore.getCacheValue('role');
  if (savedRole) await startWorkspace(savedRole);
  else renderRoleSelect(onRoleSelected);
}

async function onRoleSelected(role) {
  await cacheStore.setCacheValue('role', role);
  await startWorkspace(role);
}

async function startWorkspace(role) {
  state.role = role;
  state.blockedPeers = new Set((await blocklist.listBlockedPeers()).map((b) => b.peerId));

  if (role === 'candidate') {
    state.ranker = new MatchingRanker(null, 'candidate'); // localProfile posé après upload
    renderCandidateWorkspace({
      webgpuAvailable: state.webgpuAvailable,
      models: MODEL_CATALOG,
      onDocumentSubmit: handleCandidateDocumentSubmit,
      onLoadModel: handleLoadModel,
      onResetLocalData: handleResetLocalData,
      onChangeRole: changeRole,
    });
  } else {
    renderRecruiterWorkspace({
      webgpuAvailable: state.webgpuAvailable,
      models: MODEL_CATALOG,
      postings: [],
      onAddPosting: handleAddPosting,
      onLoadModel: handleLoadModel,
      onResetLocalData: handleResetLocalData,
      onChangeRole: changeRole,
      onRemovePosting: removePosting,
      onThresholdInput: handleThresholdInput,
      onThresholdCommit: handleThresholdCommit,
      onOpenCandidate: onOpenCandidateMatch,
    });
  }
  log(`Mode ${role === 'candidate' ? 'candidat' : 'recruteur'} activé.`);
}

/** Revient à l'écran de choix de rôle sans effacer les données déjà stockées (§13). */
async function changeRole() {
  state.nostrSub?.close();
  state.trystero?.leave();
  state.nostrSub = null;
  state.trystero = null;
  state.localProfile = null;
  state.postings = new Map();
  await cacheStore.deleteCacheValue('role');
  renderRoleSelect(onRoleSelected);
}

async function handleLoadModel(modelId) {
  if (!modelId) { log('Aucun modèle sélectionné : le matching reste déterministe (CPU).'); return; }
  log(`Chargement du modèle ${modelId}...`);
  try {
    await llm.loadModel(modelId);
    log('Modèle prêt.');
  } catch (e) {
    log(`Échec du chargement du modèle : ${e.message}. Le matching déterministe reste disponible.`);
  }
}

/** Parse + extrait + (optionnel) analyse sémantique un document déposé. */
async function analyzeInput(input, kind, documentId) {
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
  return { doc, facts, semantic };
}

// =====================================================================
// Mode candidat
// =====================================================================

async function handleCandidateDocumentSubmit(input) {
  const documentId = `cv_${Date.now()}`;
  log('Analyse locale du CV (CPU)...');
  const { facts, semantic } = await analyzeInput(input, 'cv', documentId);

  const profile = buildCandidateProfile({ documentId, facts, semantic });
  state.localProfile = profile;
  state.displayName = input.displayName || null;
  state.ranker.localProfile = profile;

  await profilesStore.saveProfile(profile);
  log('Profil de matching prêt (le CV original reste local et inchangé).');

  await ensureNetwork();
  await publishOwnProfile();
}

function onOpenCandidateMatchForCandidate(entry) {
  renderMatchDetail(entry, {
    onProposeChat: () => proposeChat(entry.peerId, entry.postingId),
    onBlockPeer: () => blockPeerFromUi(entry.peerId),
    onIgnorePeer: () => { state.ranker.removePeer(entry.peerId); log(`Profil de ${entry.peerId.slice(0, 8)}… retiré du classement pour cette session.`); },
  });
}

// =====================================================================
// Mode recruteur — annonces multiples (§1, §15)
// =====================================================================

async function handleAddPosting(input) {
  if (state.postings.size >= MAX_POSTINGS_PER_RECRUITER) {
    log(`Limite atteinte : ${MAX_POSTINGS_PER_RECRUITER} annonces actives maximum.`);
    return;
  }
  const postingId = `job_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  log('Analyse locale de l\'annonce (CPU)...');
  const { facts, semantic } = await analyzeInput(input, 'job', postingId);
  const profile = buildJobProfile({ documentId: postingId, facts, semantic });
  await profilesStore.saveProfile(profile);

  const title = input.displayName || profile.responsibilities?.[0]?.slice(0, 60) || 'Annonce sans titre';
  const ranker = new MatchingRanker(profile, 'recruiter');
  ranker.onRankingChange(() => refreshPostingsUi());

  state.postings.set(postingId, { id: postingId, title, profile, threshold: DEFAULT_VISIBILITY_THRESHOLD, ranker });
  log(`Annonce publiée : « ${title} ».`);

  await ensureNetwork();
  await publishOwnProfile();
  refreshPostingsUi();
}

function removePosting(postingId) {
  state.postings.delete(postingId);
  log('Annonce retirée.');
  publishOwnProfile();
  refreshPostingsUi();
}

/** Retour temps réel pendant le drag du curseur : filtre local uniquement, pas de réseau à chaque pixel. */
function handleThresholdInput(postingId, value) {
  const posting = state.postings.get(postingId);
  if (!posting) return;
  posting.threshold = value;
  posting.ranker.setOwnThreshold(value);

  // Diffusion immédiate aux pairs déjà connectés — c'est CE canal qui rend
  // le curseur "temps réel" pour les candidats déjà présents sur le
  // réseau, sans attendre une republication Nostr (plus lente).
  state.trystero?.send(createThresholdUpdate({ postingId, threshold: value }));

  refreshPostingsUi();
}

/** Au relâchement du curseur : republie le profil complet sur Nostr (débounced, §78 — éviter le bruit réseau). */
function handleThresholdCommit(postingId, value) {
  handleThresholdInput(postingId, value);
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => publishOwnProfile(), THRESHOLD_PUBLISH_DEBOUNCE_MS);
}

function refreshPostingsUi() {
  const postings = Array.from(state.postings.values()).map((p) => ({
    id: p.id,
    title: p.title,
    threshold: p.threshold,
    candidates: Array.from(p.ranker.scores.entries()).map(([peerId, s]) => ({
      ...s,
      peerId,
      visible: s.total >= p.threshold,
    })).sort((a, b) => b.total - a.total),
  }));
  renderPostingsList(postings, {
    onRemovePosting: removePosting,
    onThresholdInput: handleThresholdInput,
    onThresholdCommit: handleThresholdCommit,
    onOpenCandidate: onOpenCandidateMatch,
  });
}

function onOpenCandidateMatch(entry, posting) {
  renderMatchDetail(entry, {
    onProposeChat: () => proposeChat(entry.peerId, posting.id),
    onBlockPeer: () => blockPeerFromUi(entry.peerId),
    onIgnorePeer: () => { posting.ranker.removePeer(entry.peerId); refreshPostingsUi(); },
  });
}

// =====================================================================
// Réseau : Trystero (transport) + Nostr (découverte/signalisation)
// =====================================================================

async function ensureNetwork() {
  if (state.trystero && state.nostrSub) return;
  log('Connexion au réseau P2P...');

  try {
    const trysteroLib = await import('trystero/nostr');
    state.trystero = joinMatchingRoom(trysteroLib, { appId: APP_ROOM_ID }, APP_ROOM_ID);
    state.trystero.onMessage(handleIncomingMessage);
    state.trystero.onPeerJoin((peerId) => log(`Pair connecté : ${peerId.slice(0, 8)}…`));
    state.trystero.onPeerLeave((peerId) => {
      log(`Pair déconnecté : ${peerId.slice(0, 8)}…`);
      state.ranker?.removePeer(peerId);
      for (const p of state.postings.values()) p.ranker.removePeer(peerId);
      refreshPostingsUi();
    });
  } catch (e) {
    log(`Trystero indisponible (${e.message}). Le matching reste local uniquement.`);
  }

  try {
    const nostrLib = await import('nostr-tools');
    state.nostrLib = nostrLib;
    state.identity = state.identity || createLocalIdentity(nostrLib);
    state.nostrSub = subscribeToDiscovery(nostrLib, (profile) => {
      if (state.blockedPeers.has(profile.peerId)) return; // (§75)
      ingestDiscoveredProfile(profile);
    });
    state.nostrPool = state.nostrSub.pool;
  } catch (e) {
    log(`Nostr indisponible (${e.message}). Découverte désactivée pour cette session.`);
  }
}

function ingestDiscoveredProfile(profile) {
  if (state.role === 'candidate') {
    state.ranker?.ingestPeerProfile(profile.peerId, profile);
    renderMatchList(rankingFor(state.ranker), onOpenCandidateMatchForCandidate);
  } else {
    for (const posting of state.postings.values()) posting.ranker.ingestPeerProfile(profile.peerId, profile);
    refreshPostingsUi();
  }
}

/** Rejoue le classement courant filtré d'un ranker (mode candidat) sans dépendre d'un état d'événement en attente. */
function rankingFor(ranker) {
  const rows = Array.from(ranker.scores.entries()).map(([key, s]) => ({ ...s, _key: key }))
    .filter((e) => e.total >= (ranker.thresholds.get(e._key) ?? 0));
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

/** Construit et publie le PeerProfile minimal courant (§11, §51) — jamais le document complet. */
async function publishOwnProfile() {
  if (!state.identity || !state.nostrLib || !state.nostrPool) return;
  const profile = buildOwnPeerProfile();
  try {
    await publishProfile(state.nostrLib, state.nostrPool, state.identity, profile);
    log('Profil minimal (re)publié sur Nostr (le document original n\'est jamais publié).');
  } catch (e) {
    log(`Publication Nostr échouée (${e.message}).`);
  }
  // Diffusion immédiate aux pairs déjà connectés via Trystero (plus rapide que d'attendre les relais Nostr).
  state.trystero?.send({ type: MessageType.PROFILE_ANNOUNCEMENT, version: 1, id: `local_${Date.now()}`, timestamp: Date.now(), profile });
}

function buildOwnPeerProfile() {
  const peerId = state.identity.publicKey;
  if (state.role === 'candidate') {
    const p = state.localProfile;
    return {
      peerId,
      role: 'candidate',
      capabilities: {
        displayName: state.displayName ?? undefined,
        skills: (p?.skills ?? []).map((s) => s.name),
        domains: p?.domains ?? [],
        seniority: p?.seniority ?? undefined,
        locations: p?.preferences?.locations ?? [],
        languages: p?.languages ?? [],
      },
      updatedAt: Date.now(),
    };
  }
  return {
    peerId,
    role: 'recruiter',
    capabilities: {
      displayName: state.displayName ?? undefined,
      postings: Array.from(state.postings.values()).map((posting) => ({
        id: posting.id,
        title: posting.title,
        skills: (posting.profile.requiredSkills ?? []).map((s) => s.name),
        domains: posting.profile.domains ?? [],
        seniority: posting.profile.seniority ?? undefined,
        locations: posting.profile.locations ?? [],
        languages: posting.profile.languages ?? [],
        visibilityThreshold: posting.threshold,
      })),
    },
    updatedAt: Date.now(),
  };
}

function handleIncomingMessage(message, peerId) {
  if (state.blockedPeers.has(peerId)) return; // pair bloqué : silence total (§75)

  switch (message.type) {
    case MessageType.PROFILE_ANNOUNCEMENT:
      ingestDiscoveredProfile(message.profile);
      break;
    case MessageType.THRESHOLD_UPDATE:
      if (state.role === 'candidate') {
        state.ranker.applyThresholdUpdate(peerId, message.postingId, message.threshold);
        renderMatchList(rankingFor(state.ranker), onOpenCandidateMatchForCandidate);
      }
      break;
    case MessageType.CHAT_REQUEST:
      log(`Proposition de chat reçue de ${peerId.slice(0, 8)}…`);
      renderChat.showIncomingRequest?.(peerId, message, (accepted) => respondToChatRequest(peerId, message, accepted), () => blockPeerFromUi(peerId));
      break;
    case MessageType.CHAT_RESPONSE:
      if (message.accepted) openChatThread(peerId);
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

// =====================================================================
// Chat P2P (§38-41)
// =====================================================================

function proposeChat(peerId, postingId) {
  const msg = createChatRequest({ toPeerId: peerId, jobOrCandidateRef: postingId || state.localProfile?.id });
  state.trystero?.send(msg, peerId);
  log(`Proposition de chat envoyée à ${peerId.slice(0, 8)}… (double consentement requis, §38)`);
}

function respondToChatRequest(peerId, requestMessage, accepted) {
  const response = createChatResponse({ toPeerId: peerId, requestId: requestMessage.id, accepted });
  state.trystero?.send(response, peerId);
  if (accepted) openChatThread(peerId);
}

async function openChatThread(peerId) {
  await chatStore.saveThread({ peerId, createdAt: Date.now(), active: true });
  const history = await chatStore.listMessagesForPeer(peerId);
  const peerName = findKnownDisplayName(peerId);
  renderChat.open(peerId, history, (text) => sendChatMessage(peerId, text), peerName);
}

/** Cherche le nom affiché connu pour un pair, côté candidat (clés composites) ou recruteur (clé simple). */
function findKnownDisplayName(peerId) {
  if (state.role === 'candidate' && state.ranker) {
    for (const entry of state.ranker.peerProfiles.values()) {
      if (entry.peerId === peerId && entry.displayName) return entry.displayName;
    }
  } else {
    for (const posting of state.postings.values()) {
      const raw = posting.ranker.peerProfiles.get(peerId);
      if (raw?.capabilities?.displayName) return raw.capabilities.displayName;
    }
  }
  return null;
}

function sendChatMessage(peerId, text) {
  const msg = createChatMessage({ toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  renderChat.appendMessage(peerId, { senderId: 'me', text: msg.text, timestamp: msg.timestamp });
}

// =====================================================================
// Confidentialité (§54, §75)
// =====================================================================

async function blockPeerFromUi(peerId) {
  await blocklist.blockPeer(peerId);
  state.blockedPeers.add(peerId);
  state.ranker?.removePeer(peerId);
  for (const p of state.postings.values()) p.ranker.removePeer(peerId);
  refreshPostingsUi();
  log(`Pair bloqué : ${peerId.slice(0, 8)}… (aucune notification envoyée au pair)`);
}

async function handleResetLocalData() {
  state.nostrSub?.close();
  state.trystero?.leave();
  await wipeAllLocalData();
  log('Toutes les données locales ont été supprimées (§54).');
  window.location.reload();
}

init();
