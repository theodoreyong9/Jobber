// src/app/main.js
//
// Point d'entrée. Flux asymétrique :
//
//   CANDIDAT  : nom + mots-clés + ville(s) (virgules pour en donner
//               plusieurs) + CV (fichier) -> analyse CPU automatique dès
//               le dépôt du fichier -> "Booster avec l'IA" optionnel
//               (ajoute des mots-clés supplémentaires AVANT l'envoi,
//               jamais après) -> "Rechercher en direct" diffuse le tout.
//
//   RECRUTEUR : nom + une ou plusieurs salles d'annonce (texte collé,
//               jamais publié) + ancienneté minimale optionnelle. Simple
//               comparaison CPU par mots-clés, un seul score, pas de
//               couche IA de ce côté (§ retour : l'IA a plus de sens côté
//               candidat, avant l'envoi, que côté recruteur en continu).

import { parseDocument } from '../core/parser/documentParser.js';
import { extractFacts } from '../core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile, parseCommaList } from '../core/extraction/buildProfile.js';
import { normalizeSkill } from '../core/normalization/normalize.js';
import { MAX_POSTINGS_PER_RECRUITER } from '../config/matching.js';

import { RoomRanker } from '../p2p/discovery.js';
import { joinMatchingRoom } from '../p2p/trystero.js';
import { MessageType, createCandidateBroadcast, createIdentityRetired, createChatRequest, createMeetingProposal, createChatResponse, createChatMessage } from '../p2p/protocol.js';

import * as chatStore from '../storage/chat.js';
import * as blocklist from '../storage/blocklist.js';
import * as identityStore from '../storage/identity.js';
import { wipeAllLocalData } from '../storage/idb.js';
import { validateCandidateBroadcast } from '../core/validation/schema.js';

import * as llm from '../llm/provider.js';
import { MODEL_CATALOG } from '../models/catalog.js';

import {
  renderRoleSelect, renderCandidateWorkspace, renderCvAnalysisSection, renderProposalList,
  renderRecruiterWorkspace, renderRoomsList, renderCandidateDetail,
  renderChat, renderLog,
} from '../ui/render.js';

const AI_MODEL_ID = MODEL_CATALOG.find((m) => m.tier === 'light')?.id ?? MODEL_CATALOG[0].id;
const APP_ROOM_ID = 'jobmatch-p2p-v1';

let mammothLoadPromise = null;
function loadMammothBrowserBundle() {
  if (typeof window !== 'undefined' && window.mammoth) return Promise.resolve(window.mammoth);
  if (mammothLoadPromise) return mammothLoadPromise;
  mammothLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
    script.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('mammoth chargé mais window.mammoth est absent.')));
    script.onerror = () => reject(new Error('échec du chargement du script mammoth (réseau ou CDN indisponible).'));
    document.head.appendChild(script);
  });
  return mammothLoadPromise;
}

const NOSTR_RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://offchain.pub',
];

const state = {
  role: null,
  identity: null,
  trystero: null,
  blockedPeers: new Set(),
  isLive: false,
  webgpuAvailable: false,

  localProfile: null,
  cvFile: null,
  cvRawText: null,
  searchKeywords: [],
  cities: [],
  boostStatus: 'off',
  proposals: [],

  rooms: new Map(),
  activeRoomId: null,
  openCandidateContext: null,
  receivedCvUrls: new Map(),
};

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  renderLog(line);
  console.log(line);
}

async function init() {
  state.identity = await identityStore.loadOrCreateIdentity();
  state.blockedPeers = new Set((await blocklist.listBlockedPeers()).map((b) => b.peerId));
  state.webgpuAvailable = await llm.detectWebGpuSupport().catch(() => false);

  const savedRole = await getSavedRole();
  if (savedRole) await startWorkspace(savedRole);
  else renderRoleSelect(onRoleSelected);
}

let sessionRole = null;
async function getSavedRole() { return sessionRole; }

async function onRoleSelected(role) {
  sessionRole = role;
  await startWorkspace(role);
}

async function saveDisplayName(name) {
  state.identity = await identityStore.setDisplayName(name);
  log(`Nom mis à jour : ${state.identity.displayName || '(vide)'}.`);
  if (state.trystero) broadcastIfCandidate();
}

async function restoreIdentity(id) {
  try {
    state.identity = await identityStore.restoreIdentity(id);
    log(`Identité restaurée : id ${state.identity.id}.`);
    await startWorkspace(state.role);
    if (state.trystero) broadcastIfCandidate();
  } catch (e) {
    log(`Restauration impossible : ${e.message}`);
  }
}

async function invalidateIdentity() {
  const oldId = state.identity.id;
  if (state.role === 'candidate' && state.isLive) {
    state.trystero?.send(createIdentityRetired({ retiredId: oldId }));
  }
  state.identity = await identityStore.regenerateId();
  log(`ID invalidé. Nouvel ID : ${state.identity.id}.`);
  await startWorkspace(state.role);
  if (state.trystero && state.role === 'candidate' && state.isLive) {
    broadcastIfCandidate();
  }
}

async function startWorkspace(role) {
  state.role = role;
  if (role === 'candidate') {
    renderCandidateWorkspace({
      identity: state.identity,
      isLive: state.isLive,
      onSaveName: saveDisplayName,
      onChangeRole: changeRole,
      onFileSelected: analyzeCv,
      onStartLive: startCandidateLive,
      onResetSearch: resetSearch,
      onResetLocalData: handleResetLocalData,
      onRestoreId: restoreIdentity,
      onInvalidateId: invalidateIdentity,
    });
    if (state.localProfile) {
      renderCvAnalysisSection(state.localProfile, {
        boostStatus: state.boostStatus,
        webgpuAvailable: state.webgpuAvailable,
        onBoost: boostKeywordsNow,
      });
    }
    renderProposalList(state.proposals, { onAccept: acceptProposal, onDecline: declineProposal });
  } else {
    renderRecruiterWorkspace({
      identity: state.identity,
      rooms: [],
      activeRoomId: state.activeRoomId,
      onSaveName: saveDisplayName,
      onChangeRole: changeRole,
      onCreateRoom: createRoom,
      onResetLocalData: handleResetLocalData,
      onRestoreId: restoreIdentity,
      onInvalidateId: invalidateIdentity,
      onSelectRoom: selectRoom,
      onOpenCandidate: onOpenCandidateDetail,
      onRemoveRoom: removeRoom,
    });
    refreshRoomsUi();
  }
  log(`Mode ${role === 'candidate' ? 'candidat' : 'annonceur'} activé.`);
}

function selectRoom(roomId) {
  state.activeRoomId = roomId;
  state.openCandidateContext = null;
  refreshRoomsUi();
}

async function changeRole() {
  state.trystero?.leave();
  state.trystero = null;
  state.isLive = false;
  state.localProfile = null;
  state.cvFile = null;
  state.cvRawText = null;
  state.searchKeywords = [];
  state.cities = [];
  state.boostStatus = 'off';
  state.proposals = [];
  state.rooms = new Map();
  state.activeRoomId = null;
  state.openCandidateContext = null;
  sessionRole = null;
  renderRoleSelect(onRoleSelected);
}

async function ensureNetwork() {
  if (state.trystero) return;
  log('Connexion au réseau P2P...');
  try {
    const trysteroLib = await import('trystero');
    state.trystero = joinMatchingRoom(trysteroLib, { appId: APP_ROOM_ID, relayConfig: { urls: NOSTR_RELAY_URLS } }, APP_ROOM_ID);
    state.trystero.onMessage(handleIncomingMessage);
    state.trystero.onFile(handleIncomingFile);
    state.trystero.onPeerJoin((peerId) => {
      log(`Pair connecté : ${peerId.slice(0, 8)}…`);
      broadcastIfCandidate(peerId);
    });
    state.trystero.onPeerLeave((peerId) => {
      log(`Pair déconnecté : ${peerId.slice(0, 8)}…`);
      for (const room of state.rooms.values()) room.ranker.removePeer(peerId);
      refreshRoomsUi();
    });
  } catch (e) {
    log(`Réseau P2P indisponible (${e.message}).`);
  }
}

function broadcastIfCandidate(targetPeerId) {
  if (state.role !== 'candidate' || !state.localProfile || state.searchKeywords.length === 0) return;
  const msg = createCandidateBroadcast({
    senderId: state.identity.id,
    displayName: state.identity.displayName,
    searchKeywords: state.searchKeywords,
    skills: state.localProfile.keywords,
    cities: state.cities,
    yearsOfExperience: state.localProfile.yearsOfExperience,
    yearsOfExperienceEstimated: state.localProfile.yearsOfExperienceEstimated,
    cvFileName: state.cvFile?.name ?? null,
  });
  state.trystero?.send(msg, targetPeerId);
  if (state.cvFile) {
    state.trystero?.sendFile(state.cvFile, { name: state.cvFile.name, mimeType: state.cvFile.type }, targetPeerId);
  }
}

async function analyzeCv(file) {
  const documentId = `cv_${Date.now()}`;
  log('Analyse locale du CV (CPU, mots-clés uniquement)...');

  let mammothLib = null;
  if (file.name.toLowerCase().endsWith('.docx')) {
    try {
      mammothLib = await loadMammothBrowserBundle();
    } catch (e) {
      log(`Lecture du .docx impossible (${e.message}). Réessayez, ou utilisez un fichier .txt en attendant.`);
      return;
    }
  }
  const doc = await parseDocument({ file, kind: 'cv', id: documentId, mammothLib });
  const { facts } = extractFacts(doc);
  state.localProfile = buildCandidateProfile({ documentId, facts });
  state.cvFile = file;
  state.cvRawText = doc.rawText;
  state.boostStatus = 'off';

  const expNote = state.localProfile.yearsOfExperience == null
    ? 'ancienneté inconnue'
    : `${state.localProfile.yearsOfExperience} an(s)${state.localProfile.yearsOfExperienceEstimated ? ' (estimée à partir des dates du CV)' : ' (explicite)'}`;
  log(`Mots-clés extraits : ${state.localProfile.keywords.join(', ') || '(aucun détecté)'} — ${expNote}.`);

  renderCvAnalysisSection(state.localProfile, {
    boostStatus: state.boostStatus,
    webgpuAvailable: state.webgpuAvailable,
    onBoost: boostKeywordsNow,
  });
}

async function boostKeywordsNow() {
  if (!state.localProfile || !state.cvRawText) return;
  if (!state.webgpuAvailable) {
    log('WebGPU indisponible dans ce navigateur : boost impossible. Vos mots-clés CPU restent utilisables.');
    return;
  }
  state.boostStatus = 'loading';
  renderCvAnalysisSection(state.localProfile, { boostStatus: state.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: boostKeywordsNow });

  try {
    await llm.loadModel(AI_MODEL_ID);
    const result = await llm.boostKeywords({ cvText: state.cvRawText, currentKeywords: state.localProfile.keywords });
    if (result.ok && result.keywords.length > 0) {
      const existing = new Set(state.localProfile.keywords);
      let added = 0;
      for (const raw of result.keywords) {
        const { normalized } = normalizeSkill(raw);
        if (normalized && !existing.has(normalized)) {
          existing.add(normalized);
          state.localProfile.keywords.push(normalized);
          added += 1;
        }
      }
      state.boostStatus = 'done';
      log(`Boost IA : ${added} mot(s)-clé(s) ajouté(s) (${result.keywords.join(', ')}).`);
    } else {
      state.boostStatus = 'error';
      log('Boost IA : aucune suggestion exploitable. Vos mots-clés CPU restent inchangés.');
    }
  } catch (e) {
    state.boostStatus = 'error';
    log(`Boost IA indisponible (${e.message}). Vos mots-clés CPU restent inchangés.`);
  }

  renderCvAnalysisSection(state.localProfile, { boostStatus: state.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: boostKeywordsNow });
  if (state.isLive) broadcastIfCandidate();
}

async function startCandidateLive(searchKeywordsRaw, citiesRaw) {
  if (!state.localProfile || !state.cvFile) {
    log('Déposez et laissez analyser votre CV avant de lancer la recherche.');
    return;
  }
  const keywords = parseCommaList(searchKeywordsRaw);
  if (keywords.length === 0) {
    log('Au moins un mot-clé de recherche est requis.');
    return;
  }
  state.searchKeywords = keywords;
  state.cities = parseCommaList(citiesRaw);

  await ensureNetwork();
  state.isLive = true;
  broadcastIfCandidate();
  log(`En direct : recherche "${state.searchKeywords.join(', ')}"${state.cities.length ? ` · ${state.cities.join(', ')}` : ''} — CV diffusé aux annonceurs connectés.`);
  await startWorkspace('candidate');
}

async function resetSearch() {
  if (state.isLive) {
    state.trystero?.send(createIdentityRetired({ retiredId: state.identity.id }));
    log('Recherche arrêtée : les annonceurs connectés ne vous voient plus.');
  }
  state.localProfile = null;
  state.cvFile = null;
  state.cvRawText = null;
  state.searchKeywords = [];
  state.cities = [];
  state.boostStatus = 'off';
  state.isLive = false;
  await startWorkspace('candidate');
}

function addProposal(proposal) {
  state.proposals.push(proposal);
  renderProposalList(state.proposals, { onAccept: acceptProposal, onDecline: declineProposal });
}

function acceptProposal(proposal) {
  const response = createChatResponse({ toPeerId: proposal.peerId, requestId: proposal.id, accepted: true });
  state.trystero?.send(response, proposal.peerId);
  state.proposals = state.proposals.filter((p) => p.id !== proposal.id);
  renderProposalList(state.proposals, { onAccept: acceptProposal, onDecline: declineProposal });
  openChatThread(proposal.peerId, proposal.fromName);
}

function declineProposal(proposal) {
  const response = createChatResponse({ toPeerId: proposal.peerId, requestId: proposal.id, accepted: false });
  state.trystero?.send(response, proposal.peerId);
  state.proposals = state.proposals.filter((p) => p.id !== proposal.id);
  renderProposalList(state.proposals, { onAccept: acceptProposal, onDecline: declineProposal });
}

async function createRoom({ title, text, minYearsRequired }) {
  if (state.rooms.size >= MAX_POSTINGS_PER_RECRUITER) {
    log(`Limite atteinte : ${MAX_POSTINGS_PER_RECRUITER} salles actives maximum.`);
    return;
  }
  const roomLocalId = `room_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  log('Analyse locale de l\'annonce (CPU, mots-clés uniquement)...');
  const doc = await parseDocument({ text, kind: 'job', id: roomLocalId });
  const { facts } = extractFacts(doc);
  const jobProfile = buildJobProfile({ documentId: roomLocalId, facts, rawText: text, minYearsRequired });

  const finalTitle = title || text.split('\n')[0].slice(0, 60) || 'Annonce sans titre';
  const ranker = new RoomRanker(jobProfile, finalTitle);
  ranker.onRankingChange(() => refreshRoomsUi());

  state.rooms.set(roomLocalId, { id: roomLocalId, title: finalTitle, text, jobProfile, ranker });
  state.activeRoomId = roomLocalId;
  log(`Salle publiée : « ${finalTitle} » (mots-clés : ${jobProfile.keywords.join(', ') || 'aucun détecté'}${minYearsRequired != null ? `, ancienneté min. ${minYearsRequired} an(s)` : ''}).`);

  await ensureNetwork();
  refreshRoomsUi();
}

function removeRoom(roomId) {
  state.rooms.delete(roomId);
  if (state.activeRoomId === roomId) {
    const remaining = Array.from(state.rooms.keys());
    state.activeRoomId = remaining[0] || null;
  }
  log('Salle d\'annonce retirée.');
  refreshRoomsUi();
}

function refreshRoomsUi() {
  const rooms = Array.from(state.rooms.values()).map((r) => ({
    id: r.id,
    title: r.title,
    text: r.text,
    candidates: Array.from(r.ranker.scores.values()).sort((a, b) => b.total - a.total),
  }));
  if (!state.activeRoomId && rooms.length > 0) state.activeRoomId = rooms[0].id;
  renderRoomsList(rooms, state.activeRoomId, { onSelectRoom: selectRoom, onOpenCandidate: onOpenCandidateDetail, onRemoveRoom: removeRoom });

  const ctx = state.openCandidateContext;
  if (ctx && ctx.roomId === state.activeRoomId) {
    const room = state.rooms.get(ctx.roomId);
    const entry = room && Array.from(room.ranker.scores.values()).find((s) => s.peerId === ctx.peerId);
    if (room && entry) onOpenCandidateDetail(entry, room, { skipContextUpdate: true });
  }
}

function onOpenCandidateDetail(entry, room, opts = {}) {
  if (!opts.skipContextUpdate) state.openCandidateContext = { roomId: room.id, peerId: entry.peerId };
  renderCandidateDetail(entry, {
    cvUrl: state.receivedCvUrls.get(entry.peerId) || null,
    onProposeContact: (note) => {
      const who = entry.displayName || entry.peerId.slice(0, 8) + '…';
      if (note) {
        const msg = createMeetingProposal({ toPeerId: entry.peerId, roomTitle: room.title, note, fromName: state.identity.displayName, fromId: state.identity.id });
        state.trystero?.send(msg, entry.peerId);
        log(`Proposition de rendez-vous envoyée à ${who}.`);
      } else {
        const msg = createChatRequest({ toPeerId: entry.peerId, roomTitle: room.title, fromName: state.identity.displayName, fromId: state.identity.id });
        state.trystero?.send(msg, entry.peerId);
        log(`Proposition de chat envoyée à ${who}.`);
      }
    },
  });
}

function handleIncomingMessage(message, peerId) {
  if (state.blockedPeers.has(peerId)) return;

  switch (message.type) {
    case MessageType.CANDIDATE_BROADCAST: {
      const validation = validateCandidateBroadcast({ ...message, peerId });
      if (!validation.ok) { console.warn('[main] diffusion candidat rejetée', peerId, validation.errors); break; }
      if (state.role === 'recruiter') {
        for (const room of state.rooms.values()) {
          room.ranker.ingestBroadcast(peerId, validation.value);
        }
        refreshRoomsUi();
      }
      break;
    }
    case MessageType.IDENTITY_RETIRED:
      if (state.role === 'recruiter' && message.retiredId) {
        for (const room of state.rooms.values()) room.ranker.retireIdentity(message.retiredId);
        refreshRoomsUi();
      }
      break;
    case MessageType.CHAT_REQUEST:
      if (state.role === 'candidate') {
        log(`Proposition de chat reçue.`);
        addProposal({ id: message.id, type: message.type, peerId, fromName: message.fromName, roomTitle: message.roomTitle });
      }
      break;
    case MessageType.MEETING_PROPOSAL:
      if (state.role === 'candidate') {
        log(`Proposition de rendez-vous reçue.`);
        addProposal({ id: message.id, type: message.type, peerId, fromName: message.fromName, roomTitle: message.roomTitle, note: message.note });
      }
      break;
    case MessageType.CHAT_RESPONSE:
      if (message.accepted) openChatThread(peerId);
      else log(`Proposition refusée par ${peerId.slice(0, 8)}…`);
      break;
    case MessageType.CHAT_MESSAGE:
      chatStore.saveMessage({ id: message.id, peerId, senderId: peerId, timestamp: message.timestamp, text: message.text });
      renderChat.appendMessage(peerId, { senderId: peerId, text: message.text, timestamp: message.timestamp });
      break;
    default:
      break;
  }
}

function handleIncomingFile(blob, meta, peerId) {
  if (state.blockedPeers.has(peerId)) return;
  if (state.role !== 'recruiter') return;
  const url = URL.createObjectURL(blob);
  const previous = state.receivedCvUrls.get(peerId);
  if (previous) URL.revokeObjectURL(previous);
  state.receivedCvUrls.set(peerId, url);
  log(`CV reçu de ${peerId.slice(0, 8)}… (${meta?.name || 'fichier'}).`);
  if (state.openCandidateContext?.peerId === peerId) refreshRoomsUi();
}

async function openChatThread(peerId, peerName) {
  await chatStore.saveThread({ peerId, createdAt: Date.now(), active: true });
  const history = await chatStore.listMessagesForPeer(peerId);
  renderChat.open(peerId, history, (text) => sendChatMessage(peerId, text), peerName);
}

function sendChatMessage(peerId, text) {
  const msg = createChatMessage({ toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  renderChat.appendMessage(peerId, { senderId: 'me', text: msg.text, timestamp: msg.timestamp });
}

async function handleResetLocalData() {
  if (state.role === 'candidate' && state.isLive) {
    state.trystero?.send(createIdentityRetired({ retiredId: state.identity.id }));
  }
  state.trystero?.leave();
  await wipeAllLocalData();
  identityStore.clearIdentity();
  log('Toutes les données locales ont été supprimées, y compris l\'identité (§54).');
  window.location.reload();
}

init();
