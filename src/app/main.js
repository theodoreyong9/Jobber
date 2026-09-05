// src/app/main.js
//
// Point d'entrée. Flux volontairement asymétrique et simple :
//
//   CANDIDAT  : nom + CV (fichier) -> "Rechercher en direct" -> le CPU
//               extrait des mots-clés localement, puis les DIFFUSE (avec le
//               CV en pièce jointe) à tous les pairs connectés. Pas de
//               modèle à choisir, pas d'IA ici.
//
//   RECRUTEUR : nom + une ou plusieurs salles d'annonce (texte collé, jamais
//               de fichier, jamais publié). Pour chaque salle, le CPU extrait
//               des mots-clés localement. Quand une diffusion candidat
//               arrive, elle est comparée localement aux mots-clés de
//               CHAQUE salle -> score -> classement (§30, §33-36).
//
// Aucune IA (WebLLM) dans ce flux pour l'instant — le code reste présent
// dans src/llm/ et src/worker/ pour une intégration future, simplement
// déconnecté de l'interface.

import { parseDocument } from '../core/parser/documentParser.js';
import { extractFacts } from '../core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile } from '../core/extraction/buildProfile.js';
import { MAX_POSTINGS_PER_RECRUITER } from '../config/matching.js';

import { RoomRanker } from '../p2p/discovery.js';
import { joinMatchingRoom } from '../p2p/trystero.js';
import { MessageType, createCandidateBroadcast, createChatRequest, createMeetingProposal, createChatResponse, createChatMessage } from '../p2p/protocol.js';

import * as chatStore from '../storage/chat.js';
import * as blocklist from '../storage/blocklist.js';
import * as identityStore from '../storage/identity.js';
import { wipeAllLocalData } from '../storage/idb.js';
import { validateCandidateBroadcast } from '../core/validation/schema.js';

import {
  renderRoleSelect, renderCandidateWorkspace, renderProposalList,
  renderRecruiterWorkspace, renderRoomsList, renderCandidateDetail,
  renderChat, renderLog,
} from '../ui/render.js';

const APP_ROOM_ID = 'jobmatch-p2p-v1';

let mammothLoadPromise = null;
/**
 * Charge le bundle navigateur officiel de mammoth.js via un tag <script>
 * (approche recommandée par mammoth pour un usage client, plus fiable que
 * la résolution ESM d'un paquet pensé pour Node via un CDN générique — ce
 * qui causait des échecs silencieux). Idempotent : un seul chargement,
 * réutilisé pour tous les documents suivants.
 */
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

const state = {
  role: null, // 'candidate' | 'recruiter'
  identity: null, // { id, displayName }
  trystero: null,
  blockedPeers: new Set(),
  isLive: false,

  // --- mode candidat ---
  localProfile: null,     // CandidateProfile (mots-clés extraits localement)
  cvFile: null,           // File original, jamais envoyé sauf en pièce jointe P2P
  searchKeyword: null,    // mot-clé déclaré par le candidat (filtre côté recruteur)
  proposals: [],          // demandes de chat / rendez-vous reçues

  // --- mode recruteur ---
  /** @type {Map<string, { id: string, title: string, jobProfile: any, ranker: RoomRanker }>} */
  rooms: new Map(),
  /** @type {Map<string, string>} peerId -> object URL du CV reçu */
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

  const savedRole = await getSavedRole();
  if (savedRole) await startWorkspace(savedRole);
  else renderRoleSelect(onRoleSelected);
}

// Le rôle est un simple indicateur d'écran, pas une donnée sensible :
// on le garde en mémoire de session (pas besoin d'IndexedDB dédié) et on
// retombe sur le choix de rôle à chaque nouvelle session de navigateur —
// évite la confusion "je suis resté en mode candidat malgré moi".
let sessionRole = null;
async function getSavedRole() { return sessionRole; }

async function onRoleSelected(role) {
  sessionRole = role;
  await startWorkspace(role);
}

async function saveDisplayName(name) {
  state.identity = await identityStore.setDisplayName(name);
  log(`Nom mis à jour : ${state.identity.displayName || '(vide)'}.`);
  if (state.trystero) broadcastIfCandidate(); // republie avec le nouveau nom
}

async function startWorkspace(role) {
  state.role = role;
  if (role === 'candidate') {
    renderCandidateWorkspace({
      identity: state.identity,
      isLive: state.isLive,
      onSaveName: saveDisplayName,
      onChangeRole: changeRole,
      onStartLive: startCandidateLive,
      onResetLocalData: handleResetLocalData,
    });
    renderProposalList(state.proposals, { onAccept: acceptProposal, onDecline: declineProposal });
  } else {
    renderRecruiterWorkspace({
      identity: state.identity,
      rooms: [],
      onSaveName: saveDisplayName,
      onChangeRole: changeRole,
      onCreateRoom: createRoom,
      onResetLocalData: handleResetLocalData,
    });
    refreshRoomsUi();
  }
  log(`Mode ${role === 'candidate' ? 'candidat' : 'annonceur'} activé.`);
}

async function changeRole() {
  state.trystero?.leave();
  state.trystero = null;
  state.isLive = false;
  state.localProfile = null;
  state.cvFile = null;
  state.searchKeyword = null;
  state.proposals = [];
  state.rooms = new Map();
  sessionRole = null;
  renderRoleSelect(onRoleSelected);
}

// =====================================================================
// Réseau : une seule room Trystero partagée par tout le monde.
// =====================================================================

async function ensureNetwork() {
  if (state.trystero) return;
  log('Connexion au réseau P2P...');
  try {
    const trysteroLib = await import('trystero/nostr');
    // Config minimale : `appId` seul. On avait tenté de forcer `selfId` sur
    // notre propre identité pour garder le même identifiant réseau d'une
    // session à l'autre, mais le format ne convient pas à ce qu'attend en
    // interne la stratégie `trystero/nostr` — ça faisait planter la
    // connexion. Trystero génère donc son propre identifiant de transport,
    // éphémère ; la reconnaissance "c'est la même personne" se fait
    // maintenant au niveau applicatif, via l'identité transportée DANS les
    // messages (voir broadcastIfCandidate ci-dessous et p2p/discovery.js).
    state.trystero = joinMatchingRoom(trysteroLib, { appId: APP_ROOM_ID }, APP_ROOM_ID);
    state.trystero.onMessage(handleIncomingMessage);
    state.trystero.onFile(handleIncomingFile);
    state.trystero.onPeerJoin((peerId) => {
      log(`Pair connecté : ${peerId.slice(0, 8)}…`);
      broadcastIfCandidate(peerId); // se présente immédiatement au nouveau venu
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
  if (state.role !== 'candidate' || !state.localProfile || !state.searchKeyword) return;
  const msg = createCandidateBroadcast({
    senderId: state.identity.id,
    displayName: state.identity.displayName,
    searchKeyword: state.searchKeyword,
    skills: state.localProfile.skills.map((s) => s.name),
    domains: state.localProfile.domains,
    seniority: state.localProfile.seniority,
    locations: state.localProfile.preferences?.locations ?? [],
    languages: state.localProfile.languages,
    cvFileName: state.cvFile?.name ?? null,
  });
  state.trystero?.send(msg, targetPeerId);
  if (state.cvFile) {
    state.trystero?.sendFile(state.cvFile, { name: state.cvFile.name, mimeType: state.cvFile.type }, targetPeerId);
  }
}

// =====================================================================
// Mode candidat
// =====================================================================

async function startCandidateLive(file, searchKeyword) {
  const documentId = `cv_${Date.now()}`;
  state.searchKeyword = searchKeyword;
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

  log(`Mots-clés extraits : ${state.localProfile.skills.map((s) => s.name).join(', ') || '(aucun détecté)'}`);

  await ensureNetwork();
  state.isLive = true;
  broadcastIfCandidate(); // diffusion initiale à tous les pairs déjà présents
  log('En direct : votre CV (mots-clés + pièce jointe) est diffusé aux annonceurs connectés.');
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

// =====================================================================
// Mode recruteur — salles d'annonce multiples (§1, §15)
// =====================================================================

async function createRoom({ title, text }) {
  if (state.rooms.size >= MAX_POSTINGS_PER_RECRUITER) {
    log(`Limite atteinte : ${MAX_POSTINGS_PER_RECRUITER} salles actives maximum.`);
    return;
  }
  const roomLocalId = `room_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  log('Analyse locale de l\'annonce (CPU, mots-clés uniquement)...');
  const doc = await parseDocument({ text, kind: 'job', id: roomLocalId });
  const { facts } = extractFacts(doc);
  const jobProfile = buildJobProfile({ documentId: roomLocalId, facts });

  const finalTitle = title || text.split('\n')[0].slice(0, 60) || 'Annonce sans titre';
  const ranker = new RoomRanker(jobProfile, finalTitle);
  ranker.onRankingChange(() => refreshRoomsUi());

  state.rooms.set(roomLocalId, { id: roomLocalId, title: finalTitle, text, jobProfile, ranker });
  log(`Salle publiée : « ${finalTitle} » (mots-clés : ${jobProfile.requiredSkills.map((s) => s.name).join(', ') || 'aucun détecté'}).`);

  await ensureNetwork();
  refreshRoomsUi();
}

function removeRoom(roomId) {
  state.rooms.delete(roomId);
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
  renderRoomsList(rooms, { onOpenCandidate: onOpenCandidateDetail, onRemoveRoom: removeRoom });
}

function onOpenCandidateDetail(entry, room) {
  renderCandidateDetail(entry, {
    cvUrl: state.receivedCvUrls.get(entry.peerId) || null,
    onOpenChat: () => {
      const msg = createChatRequest({ toPeerId: entry.peerId, roomTitle: room.title, fromName: state.identity.displayName, fromId: state.identity.id });
      state.trystero?.send(msg, entry.peerId);
      log(`Proposition de chat envoyée à ${entry.displayName || entry.peerId.slice(0, 8) + '…'}.`);
    },
    onProposeMeeting: (note) => {
      const msg = createMeetingProposal({ toPeerId: entry.peerId, roomTitle: room.title, note, fromName: state.identity.displayName, fromId: state.identity.id });
      state.trystero?.send(msg, entry.peerId);
      log(`Proposition de rendez-vous envoyée à ${entry.displayName || entry.peerId.slice(0, 8) + '…'}.`);
    },
    onBlockPeer: () => blockPeerFromUi(entry.peerId),
    onIgnorePeer: () => { room.ranker.removePeer(entry.peerId); refreshRoomsUi(); },
  });
}

// =====================================================================
// Réception réseau
// =====================================================================

function handleIncomingMessage(message, peerId) {
  if (state.blockedPeers.has(peerId)) return; // (§75)

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
}

// =====================================================================
// Chat P2P (§38-41)
// =====================================================================

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

// =====================================================================
// Confidentialité (§54, §75)
// =====================================================================

async function blockPeerFromUi(peerId) {
  await blocklist.blockPeer(peerId);
  state.blockedPeers.add(peerId);
  for (const room of state.rooms.values()) room.ranker.removePeer(peerId);
  refreshRoomsUi();
  log(`Pair bloqué : ${peerId.slice(0, 8)}… (aucune notification envoyée au pair)`);
}

async function handleResetLocalData() {
  state.trystero?.leave();
  await wipeAllLocalData();
  log('Toutes les données locales ont été supprimées (§54).');
  window.location.reload();
}

init();
