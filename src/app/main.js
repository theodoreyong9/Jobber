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
//               CHAQUE salle -> score CPU -> classement (§30, §33-36).
//
// Couche IA continue (optionnelle, désactivée par défaut) : quand activée,
// chaque diffusion candidat retenue par le filtre CPU déclenche EN PLUS un
// scoring sémantique WebLLM (modèle léger fixe, pas de choix utilisateur).
// Les deux classements coexistent — le CPU ne dépend JAMAIS du GPU. Toute
// panne du GPU (WebGPU absent, modèle qui échoue à charger, appel qui
// timeout) reste strictement locale à la couche IA : elle désactive/laisse
// vide le score IA de l'entrée concernée, sans jamais toucher au score CPU
// ni faire planter le reste de l'application.

import { parseDocument } from '../core/parser/documentParser.js';
import { extractFacts } from '../core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile } from '../core/extraction/buildProfile.js';
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
  renderRoleSelect, renderCandidateWorkspace, renderProposalList,
  renderRecruiterWorkspace, renderRoomsList, renderCandidateDetail,
  renderChat, renderLog,
} from '../ui/render.js';

/** Modèle fixe pour la couche IA continue — pas de choix utilisateur (le plus léger du catalogue). */
const AI_MODEL_ID = MODEL_CATALOG.find((m) => m.tier === 'light')?.id ?? MODEL_CATALOG[0].id;

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

// Relais Nostr publics connus pour leur fiabilité — fixés explicitement
// plutôt que de dépendre de la liste par défaut de Trystero, dont certains
// relais peuvent être temporairement indisponibles (502, etc.).
const NOSTR_RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://offchain.pub',
];

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
  activeRoomId: null,
  openCandidateContext: null,

  // --- couche IA continue (optionnelle) ---
  webgpuAvailable: false,
  aiEnabled: false,
  aiStatus: 'off', // 'off' | 'loading' | 'ready' | 'error'
  aiError: null,
  sortMode: 'cpu', // 'cpu' | 'ai'
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
  state.webgpuAvailable = await llm.detectWebGpuSupport().catch(() => false);

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

/** Restaure une identité à partir d'un ID noté ailleurs (§ demande : retrouver une session). */
async function restoreIdentity(id) {
  try {
    state.identity = await identityStore.restoreIdentity(id);
    log(`Identité restaurée : id ${state.identity.id}.`);
    await startWorkspace(state.role); // réaffiche avec le nouvel ID visible
    if (state.trystero) broadcastIfCandidate(); // republie sous la nouvelle identité si déjà en direct
  } catch (e) {
    log(`Restauration impossible : ${e.message}`);
  }
}

/**
 * "Tue" l'ID courant (§ ID compromis) : génère un nouvel identifiant, en
 * conservant le nom affiché. Si on est candidat et déjà en direct, prévient
 * D'ABORD les annonceurs connectés que l'ancien ID ne représente plus
 * personne (ils retirent la ligne immédiatement), PUIS rediffuse sous le
 * nouvel ID. Ne casse pas la connexion réseau elle-même — seule l'identité
 * applicative change.
 */
async function invalidateIdentity() {
  const oldId = state.identity.id;
  if (state.role === 'candidate' && state.isLive) {
    state.trystero?.send(createIdentityRetired({ retiredId: oldId }));
  }
  state.identity = await identityStore.regenerateId();
  log(`ID invalidé. Nouvel ID : ${state.identity.id}.`);
  await startWorkspace(state.role);
  if (state.trystero && state.role === 'candidate' && state.isLive) {
    broadcastIfCandidate(); // rediffuse immédiatement sous le nouvel ID
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
      onStartLive: startCandidateLive,
      onResetLocalData: handleResetLocalData,
      onRestoreId: restoreIdentity,
      onInvalidateId: invalidateIdentity,
    });
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
      webgpuAvailable: state.webgpuAvailable,
      aiStatus: state.aiStatus,
      sortMode: state.sortMode,
      onToggleAi: toggleAiLayer,
      onSetSortMode: setSortMode,
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

function setSortMode(mode) {
  state.sortMode = mode;
  refreshRoomsUi();
}

/**
 * Active/désactive la couche IA continue (§ demande : bouton optionnel).
 * Ne touche jamais au classement CPU, qui tourne indépendamment — activer
 * ou perdre l'IA ne change que la présence ou l'absence d'un score
 * supplémentaire par candidat.
 */
async function toggleAiLayer() {
  if (state.aiEnabled) {
    state.aiEnabled = false;
    state.aiStatus = 'off';
    state.sortMode = 'cpu';
    log('Couche IA continue désactivée. Le classement CPU continue normalement.');
    await startWorkspace(state.role);
    return;
  }
  if (!state.webgpuAvailable) {
    log('WebGPU indisponible dans ce navigateur : couche IA impossible à activer. Le classement CPU reste actif.');
    return;
  }
  state.aiStatus = 'loading';
  await startWorkspace(state.role);
  try {
    await llm.loadModel(AI_MODEL_ID);
    state.aiEnabled = true;
    state.aiStatus = 'ready';
    log(`Couche IA continue activée (modèle léger : ${AI_MODEL_ID}). Elle s'ajoute au classement CPU sans le remplacer.`);
  } catch (e) {
    state.aiEnabled = false;
    state.aiStatus = 'error';
    log(`Impossible de charger le modèle IA (${e.message}). Le classement CPU reste inchangé, la couche IA reste désactivée.`);
  }
  await startWorkspace(state.role);
}

/**
 * Lance (sans bloquer) un scoring IA pour un candidat déjà retenu par le
 * filtre CPU d'une salle. Toute erreur reste locale à cette fonction —
 * jamais de rejet non attrapé, jamais d'impact sur le classement CPU.
 * @param {string} identityKey
 * @param {import('../core/validation/schema.js').CandidateBroadcast} broadcast
 */
async function scheduleAiScoring(identityKey, broadcast) {
  if (!state.aiEnabled) return;
  for (const room of state.rooms.values()) {
    if (!room.ranker.scores.has(identityKey)) continue; // pas retenu côté CPU pour cette salle : on ne sollicite pas le GPU pour rien
    if (!room.aiScores) room.aiScores = new Map();
    room.aiScores.set(identityKey, { pending: true, score: null, justification: null });
    refreshRoomsUi();
    try {
      const result = await llm.scoreRelevance({
        jobText: room.text || '',
        jobStructured: {
          keywords: room.jobProfile.keywords || [],
          minYearsRequired: room.jobProfile.minYearsRequired,
        },
        candidate: {
          searchKeyword: broadcast.searchKeyword || '',
          skills: broadcast.skills || [],
          city: broadcast.city || null,
          yearsOfExperience: typeof broadcast.yearsOfExperience === 'number' ? broadcast.yearsOfExperience : null,
        },
      });
      if (result.ok) {
        room.aiScores.set(identityKey, { pending: false, score: result.score, justification: result.justification });
      } else {
        room.aiScores.delete(identityKey); // échec silencieux : aucun score IA affiché, le score CPU reste seul et inchangé
      }
    } catch (e) {
      room.aiScores.delete(identityKey);
      log(`Scoring IA ignoré pour un candidat (${e.message}) — classement CPU inchangé.`);
    }
    refreshRoomsUi();
  }
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
  state.activeRoomId = null;
  state.openCandidateContext = null;
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
    const trysteroLib = await import('trystero');
    // Config minimale : `appId` + une liste de relais Nostr fixée
    // explicitement (voir NOSTR_RELAY_URLS ci-dessus). Ne pas essayer de
    // forcer un `selfId` personnalisé : la reconnaissance "c'est la même
    // personne" se fait au niveau applicatif, via l'identité transportée
    // DANS les messages (voir broadcastIfCandidate plus bas), pas au
    // niveau du transport.
    state.trystero = joinMatchingRoom(trysteroLib, { appId: APP_ROOM_ID, relayConfig: { urls: NOSTR_RELAY_URLS } }, APP_ROOM_ID);
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
    skills: state.localProfile.keywords,
    city: state.localProfile.city,
    yearsOfExperience: state.localProfile.yearsOfExperience,
    yearsOfExperienceEstimated: state.localProfile.yearsOfExperienceEstimated,
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

async function startCandidateLive(file, searchKeyword, city) {
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
  state.localProfile = buildCandidateProfile({ documentId, facts, city });
  state.cvFile = file;

  const expNote = state.localProfile.yearsOfExperience == null
    ? 'ancienneté inconnue'
    : `${state.localProfile.yearsOfExperience} an(s)${state.localProfile.yearsOfExperienceEstimated ? ' (estimée à partir des dates du CV)' : ' (explicite)'}`;
  log(`Mots-clés extraits : ${state.localProfile.keywords.join(', ') || '(aucun détecté)'} — ${expNote}.`);

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
  state.activeRoomId = roomLocalId; // bascule automatiquement sur le nouvel onglet
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
  const rooms = Array.from(state.rooms.values()).map((r) => {
    const candidates = Array.from(r.ranker.scores.values()).map((c) => {
      const ai = r.aiScores?.get(c.identityKey);
      return { ...c, aiScore: ai?.score ?? null, aiPending: ai?.pending ?? false, aiJustification: ai?.justification ?? null };
    });
    const sorted = state.sortMode === 'ai' && state.aiEnabled
      ? candidates.sort((a, b) => (b.aiScore ?? -1) - (a.aiScore ?? -1))
      : candidates.sort((a, b) => b.total - a.total);
    return { id: r.id, title: r.title, text: r.text, candidates: sorted };
  });
  if (!state.activeRoomId && rooms.length > 0) state.activeRoomId = rooms[0].id;
  renderRoomsList(rooms, state.activeRoomId, {
    onSelectRoom: selectRoom,
    onOpenCandidate: onOpenCandidateDetail,
    onRemoveRoom: removeRoom,
    aiEnabled: state.aiEnabled,
    sortMode: state.sortMode,
    onSetSortMode: setSortMode,
  });

  // Si le détail actuellement ouvert appartient à la salle active, le
  // réaffiche avec les données à jour (score recalculé, CV enfin arrivé...) :
  // sinon la fiche reste figée sur son état au moment du clic (§ CV introuvable).
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
    // Une seule action : note vide -> simple demande de chat ; note remplie
    // -> proposition de rendez-vous avec ce message. Avant, deux boutons
    // séparés menaient au même résultat (le même chat) — fusionné pour
    // éviter la redondance sans perdre la distinction de message (§ retour utilisateur).
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
    onBlockPeer: () => { state.openCandidateContext = null; blockPeerFromUi(entry.peerId); },
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
        if (state.aiEnabled) {
          const identityKey = validation.value.senderId || peerId;
          scheduleAiScoring(identityKey, validation.value); // fire-and-forget, ne bloque jamais le flux CPU
        }
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
  // Si la fiche de ce candidat est actuellement ouverte, on la rafraîchit
  // tout de suite plutôt que de laisser "CV en cours de réception…" figé
  // jusqu'au prochain événement de scoring (§ CV introuvable).
  if (state.openCandidateContext?.peerId === peerId) refreshRoomsUi();
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
  // Un reset complet doit aussi invalider l'identité : sinon l'ID survivrait
  // à la suppression, ce qui viderait le geste de son sens (§ sécurité —
  // un ID qu'on croit "tué" doit vraiment l'être).
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
