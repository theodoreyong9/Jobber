// src/app/main.js
//
// Point d'entree. Six modes, un seul VISIBLE a la fois, groupes en trois
// patterns generiques reutilises :
//
//   SEEKER (candidat-like)   : jobCandidate (CV) / missionSeeker (propal + texte)
//   POSTER (employeur-like)  : jobRecruiter="Employeur" / missionClient="Client"
//   SYMMETRIQUE (rencontre)  : dating="Rencontre" (age) / service="Service" (lien)
//
// Chaque mode a sa propre identite (namespace separe) et continue de
// tourner en arriere-plan quand il n'est pas affiche. Une seule connexion
// P2P partagee ; chaque message est tague `domain` pour router vers le bon
// mode sans jamais les melanger.

import { parseDocument } from '../core/parser/documentParser.js';
import { extractFacts } from '../core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile, parseCommaList } from '../core/extraction/buildProfile.js';
import { normalizeSkill } from '../core/normalization/normalize.js';
import { MAX_POSTINGS_PER_RECRUITER } from '../config/matching.js';

import { RoomRanker } from '../p2p/discovery.js';
import { joinMatchingRoom } from '../p2p/trystero.js';
import {
  MessageType, Domain, createCandidateBroadcast, createIdentityRetired,
  createChatRequest, createMeetingProposal, createChatResponse, createChatMessage,
} from '../p2p/protocol.js';

import * as chatStore from '../storage/chat.js';
import * as blocklist from '../storage/blocklist.js';
import * as identityStore from '../storage/identity.js';
import { validateCandidateBroadcast } from '../core/validation/schema.js';

import * as llm from '../llm/provider.js';
import { MODEL_CATALOG } from '../models/catalog.js';

import {
  renderShell, setVisibleMode, setModeBadge,
  renderJobCandidatePanel, renderMissionSeekerPanel,
  renderJobRecruiterPanel, renderMissionClientPanel, JOB_RECRUITER_CFG, MISSION_CLIENT_CFG,
  renderCandidateDetail,
  renderDatingPanel, renderServicePanel,
  renderDatingMatches, renderServiceMatches,
  renderDatingMatchDetail, renderServiceMatchDetail,
  renderConversations, renderConversationView, renderLog,
} from '../ui/render.js';

const AI_MODEL_ID = MODEL_CATALOG.find((m) => m.tier === 'light')?.id ?? MODEL_CATALOG[0].id;
const APP_ROOM_ID = 'jobmatch-p2p-v1';

const NAMESPACE = {
  jobCandidate: 'job_candidate', jobRecruiter: 'job_recruiter',
  missionSeeker: 'mission_seeker', missionClient: 'mission_client',
  dating: 'dating', service: 'service',
};
const DOMAIN_OF = {
  jobCandidate: Domain.JOB, jobRecruiter: Domain.JOB,
  missionSeeker: Domain.MISSION, missionClient: Domain.MISSION,
  dating: Domain.DATING, service: Domain.SERVICE,
};
const SEEKER_MODE_FOR_DOMAIN = { [Domain.JOB]: 'jobCandidate', [Domain.MISSION]: 'missionSeeker' };
const POSTER_MODE_FOR_DOMAIN = { [Domain.JOB]: 'jobRecruiter', [Domain.MISSION]: 'missionClient' };
const SYMMETRIC_MODE_FOR_DOMAIN = { [Domain.DATING]: 'dating', [Domain.SERVICE]: 'service' };

const SEEKER_RENDER_FN = { jobCandidate: renderJobCandidatePanel, missionSeeker: renderMissionSeekerPanel };
const SEEKER_CONTAINERS = {
  jobCandidate: { tabsId: 'jc-tabs', convId: 'jc-conversation' },
  missionSeeker: { tabsId: 'ms-tabs', convId: 'ms-conversation' },
};
const POSTER_RENDER_FN = { jobRecruiter: renderJobRecruiterPanel, missionClient: renderMissionClientPanel };
const POSTER_CFG = { jobRecruiter: JOB_RECRUITER_CFG, missionClient: MISSION_CLIENT_CFG };
const SYMMETRIC_RENDER_FN = { dating: renderDatingPanel, service: renderServicePanel };
const SYMMETRIC_MATCHES_FN = { dating: renderDatingMatches, service: renderServiceMatches };
const SYMMETRIC_MATCH_DETAIL_FN = { dating: renderDatingMatchDetail, service: renderServiceMatchDetail };
const SYMMETRIC_CONTAINERS = {
  dating: { tabsId: 'dt-tabs', convId: 'dt-conversation' },
  service: { tabsId: 'sv-tabs', convId: 'sv-conversation' },
};

const NOSTR_RELAY_URLS = [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band', 'wss://nostr.wine', 'wss://offchain.pub',
];

let mammothLoadPromise = null;
function loadMammothBrowserBundle() {
  if (typeof window !== 'undefined' && window.mammoth) return Promise.resolve(window.mammoth);
  if (mammothLoadPromise) return mammothLoadPromise;
  mammothLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
    script.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('mammoth chargé mais window.mammoth est absent.')));
    script.onerror = () => reject(new Error('échec du chargement du script mammoth.'));
    document.head.appendChild(script);
  });
  return mammothLoadPromise;
}

function freshSeekerState() {
  return {
    identity: null, localProfile: null, cvFile: null, cvRawText: null,
    searchKeywords: [], cities: [], countries: [],
    boostStatus: 'off', isLive: false,
    conversations: new Map(), activeConversationId: null,
  };
}
function freshPosterState() {
  return {
    identity: null, rooms: new Map(), activeRoomId: null,
    openCandidateContext: null, receivedCvUrls: new Map(), knownChatPeers: new Set(),
    openChatPeerId: null, openChatHistory: [],
  };
}
function freshSymmetricState() {
  return {
    identity: null, myProfile: null, myTitle: null, myAge: null, myLink: null,
    photoFile: null, bioRawText: null,
    ranker: null, demandKeywords: [], cities: [], countries: [],
    boostStatus: 'off', isLive: false, receivedPhotoUrls: new Map(),
    conversations: new Map(), activeConversationId: null,
  };
}

const state = {
  webgpuAvailable: false,
  trystero: null,
  blockedPeers: new Set(),
  visibleMode: null,
  initializedModes: { jobCandidate: false, jobRecruiter: false, missionSeeker: false, missionClient: false, dating: false, service: false },

  jobCandidate: freshSeekerState(),
  missionSeeker: freshSeekerState(),
  jobRecruiter: freshPosterState(),
  missionClient: freshPosterState(),
  dating: freshSymmetricState(),
  service: freshSymmetricState(),
};

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  renderLog(line);
  console.log(line);
}

async function init() {
  state.blockedPeers = new Set((await blocklist.listBlockedPeers()).map((b) => b.peerId));
  state.webgpuAvailable = await llm.detectWebGpuSupport().catch(() => false);
  renderShell(state.visibleMode, toggleMode);
}

async function toggleMode(mode) {
  const showing = state.visibleMode === mode;
  state.visibleMode = showing ? null : mode;
  setVisibleMode(state.visibleMode);
  if (!state.visibleMode) return;

  if (!state.initializedModes[mode]) {
    state.initializedModes[mode] = true;
    state[mode].identity = await identityStore.loadOrCreateIdentity(NAMESPACE[mode]);
  }
  rerender(mode);
  log(`Mode ${mode} affiché.`);
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
      for (const m of Object.keys(SEEKER_RENDER_FN)) broadcastSeekerIfLive(m, peerId);
      for (const m of Object.keys(SYMMETRIC_RENDER_FN)) broadcastSymmetricIfLive(m, peerId);
    });
    state.trystero.onPeerLeave((peerId) => {
      log(`Pair déconnecté : ${peerId.slice(0, 8)}…`);
      for (const m of Object.keys(POSTER_RENDER_FN)) { for (const room of state[m].rooms.values()) room.ranker.removePeer(peerId); refreshPosterUi(m); }
      for (const m of Object.keys(SYMMETRIC_RENDER_FN)) { state[m].ranker?.removePeer(peerId); refreshSymmetricMatches(m); }
    });
  } catch (e) {
    log(`Réseau P2P indisponible (${e.message}).`);
  }
}

function identityCallbacks(modeKey) {
  const namespace = NAMESPACE[modeKey];
  const domain = DOMAIN_OF[modeKey];
  return {
    onSaveName: async (name) => {
      state[modeKey].identity = await identityStore.setDisplayName(namespace, name);
      log(`[${modeKey}] Nom mis à jour.`);
      rerender(modeKey);
      broadcastSeekerIfLive(modeKey); broadcastSymmetricIfLive(modeKey);
    },
    onRestoreId: async (id) => {
      try {
        state[modeKey].identity = await identityStore.restoreIdentity(namespace, id);
        log(`[${modeKey}] Identité restaurée : id ${state[modeKey].identity.id}.`);
        rerender(modeKey);
        broadcastSeekerIfLive(modeKey); broadcastSymmetricIfLive(modeKey);
      } catch (e) {
        log(`Restauration impossible : ${e.message}`);
      }
    },
    onInvalidateId: async () => {
      const oldId = state[modeKey].identity.id;
      const live = state[modeKey].isLive;
      if (live) state.trystero?.send(createIdentityRetired({ domain, retiredId: oldId }));
      state[modeKey].identity = await identityStore.regenerateId(namespace);
      log(`[${modeKey}] ID invalidé. Nouvel ID : ${state[modeKey].identity.id}.`);
      rerender(modeKey);
      if (live) { broadcastSeekerIfLive(modeKey); broadcastSymmetricIfLive(modeKey); }
    },
    onWipeMode: () => wipeModeData(modeKey),
  };
}

async function wipeModeData(modeKey) {
  const s = state[modeKey];
  const namespace = NAMESPACE[modeKey];
  const domain = DOMAIN_OF[modeKey];
  if (s.isLive) state.trystero?.send(createIdentityRetired({ domain, retiredId: s.identity.id }));

  const peerIds = new Set();
  if (SEEKER_RENDER_FN[modeKey] || SYMMETRIC_RENDER_FN[modeKey]) {
    for (const peerId of s.conversations.keys()) peerIds.add(peerId);
  } else if (POSTER_RENDER_FN[modeKey]) {
    for (const peerId of s.knownChatPeers) peerIds.add(peerId);
  }
  await Promise.all(Array.from(peerIds).map((peerId) => chatStore.deleteThread(peerId).catch(() => {})));

  if (SEEKER_RENDER_FN[modeKey]) Object.assign(s, freshSeekerState(), { identity: null });
  else if (POSTER_RENDER_FN[modeKey]) Object.assign(s, freshPosterState(), { identity: null });
  else if (SYMMETRIC_RENDER_FN[modeKey]) Object.assign(s, freshSymmetricState(), { identity: null });

  identityStore.clearIdentity(namespace);
  s.identity = await identityStore.loadOrCreateIdentity(namespace);
  log(`[${modeKey}] Données locales et identité supprimées (nouvel ID généré).`);
  rerender(modeKey);
}

function rerender(modeKey) {
  if (SEEKER_RENDER_FN[modeKey]) renderSeekerUi(modeKey);
  else if (POSTER_RENDER_FN[modeKey]) refreshPosterUi(modeKey);
  else if (SYMMETRIC_RENDER_FN[modeKey]) renderSymmetricUi(modeKey);
}

function renderSeekerUi(seekerMode) {
  if (state.visibleMode !== seekerMode) return;
  const s = state[seekerMode];
  SEEKER_RENDER_FN[seekerMode]({
    identity: s.identity, isLive: s.isLive,
    hasProfile: Boolean(s.localProfile), profile: s.localProfile,
    analysisOpts: { boostStatus: s.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: () => boostSeekerKeywords(seekerMode) },
    ...identityCallbacks(seekerMode),
    onFileSelected: (file) => analyzeSeekerFile(seekerMode, file),
    onStartLive: (kw, city, country, extraText) => startSeekerLive(seekerMode, kw, city, country, extraText),
    onResetSearch: () => resetSeekerSearch(seekerMode),
  });
  const c = SEEKER_CONTAINERS[seekerMode];
  renderConversations(c.tabsId, c.convId, Array.from(s.conversations.values()), s.activeConversationId, {
    onSelect: (id) => selectConversation(seekerMode, id),
    onAccept: (id) => acceptConversation(seekerMode, id),
    onDecline: (id) => declineConversation(seekerMode, id),
    onSend: (id, text) => sendConversationMessage(seekerMode, id, text),
  });
}

async function analyzeSeekerFile(seekerMode, file) {
  const s = state[seekerMode];
  const documentId = `${seekerMode}_${Date.now()}`;
  const kindLabel = seekerMode === 'missionSeeker' ? 'propal' : 'CV';
  log(`Analyse locale du ${kindLabel} (CPU, mots-clés uniquement)...`);

  let mammothLib = null;
  if (file.name.toLowerCase().endsWith('.docx')) {
    try { mammothLib = await loadMammothBrowserBundle(); }
    catch (e) { log(`Lecture du .docx impossible (${e.message}). Utilisez un .txt en attendant.`); return; }
  }
  const doc = await parseDocument({ file, kind: 'cv', id: documentId, mammothLib });
  const { facts } = extractFacts(doc);
  s.localProfile = buildCandidateProfile({ documentId, facts });
  s.cvFile = file;
  s.cvRawText = doc.rawText;
  s.boostStatus = 'off';

  log(`Mots-clés extraits : ${s.localProfile.keywords.join(', ') || '(aucun détecté)'}.`);
  renderSeekerUi(seekerMode);
}

async function boostSeekerKeywords(seekerMode) {
  const s = state[seekerMode];
  if (!s.localProfile || !s.cvRawText) return;
  await runBoost(s, () => broadcastSeekerIfLive(seekerMode));
  renderSeekerUi(seekerMode);
}

async function runBoost(modeState, onDone) {
  if (!state.webgpuAvailable) { log('WebGPU indisponible : boost impossible.'); return; }
  modeState.boostStatus = 'loading';
  try {
    await llm.loadModel(AI_MODEL_ID);
    const cvText = modeState.cvRawText ?? modeState.bioRawText ?? '';
    const target = modeState.localProfile ?? modeState.myProfile;
    const result = await llm.boostKeywords({ cvText, currentKeywords: target?.keywords ?? [] });
    if (result.ok && result.keywords.length > 0 && target) {
      const existing = new Set(target.keywords);
      let added = 0;
      for (const raw of result.keywords) {
        const { normalized } = normalizeSkill(raw);
        if (normalized && !existing.has(normalized)) { existing.add(normalized); target.keywords.push(normalized); added += 1; }
      }
      modeState.boostStatus = 'done';
      log(`Boost IA : ${added} mot(s)-clé(s) ajouté(s) (${result.keywords.join(', ')}).`);
    } else {
      modeState.boostStatus = 'error';
      log('Boost IA : aucune suggestion exploitable.');
    }
  } catch (e) {
    modeState.boostStatus = 'error';
    log(`Boost IA indisponible (${e.message}).`);
  }
  onDone?.();
}

async function startSeekerLive(seekerMode, kwRaw, cityRaw, countryRaw, extraText) {
  const s = state[seekerMode];
  const kindLabel = seekerMode === 'missionSeeker' ? 'propal' : 'CV';
  if (!s.localProfile || !s.cvFile) { log(`Déposez et laissez analyser votre ${kindLabel} avant de lancer la recherche.`); return; }
  const keywords = parseCommaList(kwRaw);
  const cities = parseCommaList(cityRaw);
  const countries = parseCommaList(countryRaw);
  if (keywords.length === 0 || cities.length === 0 || countries.length === 0) {
    log('Mot-clé, ville et pays sont tous obligatoires.');
    return;
  }
  if (seekerMode === 'missionSeeker') {
    if (!extraText || !extraText.trim()) { log('Le texte de l\'offre est obligatoire.'); return; }
    const doc = await parseDocument({ text: extraText, kind: 'cv', id: `${s.localProfile.id}_extra` });
    const { facts } = extractFacts(doc);
    const extra = buildCandidateProfile({ documentId: s.localProfile.id, facts });
    const existing = new Set(s.localProfile.keywords);
    for (const kw of extra.keywords) if (!existing.has(kw)) { existing.add(kw); s.localProfile.keywords.push(kw); }
  }
  s.searchKeywords = keywords; s.cities = cities; s.countries = countries;

  await ensureNetwork();
  s.isLive = true;
  broadcastSeekerIfLive(seekerMode);
  log(`[${seekerMode}] En direct : "${s.searchKeywords.join(', ')}" · ${s.cities.join(', ')} · ${s.countries.join(', ')} — document diffusé.`);
  renderSeekerUi(seekerMode);
}

function broadcastSeekerIfLive(seekerMode, targetPeerId) {
  const s = state[seekerMode];
  if (!SEEKER_RENDER_FN[seekerMode] || !s.isLive || !s.localProfile || s.searchKeywords.length === 0) return;
  const msg = createCandidateBroadcast({
    domain: DOMAIN_OF[seekerMode],
    senderId: s.identity.id, displayName: s.identity.displayName,
    searchKeywords: s.searchKeywords, skills: s.localProfile.keywords,
    cities: s.cities, countries: s.countries,
    yearsOfExperience: s.localProfile.yearsOfExperience,
    yearsOfExperienceEstimated: s.localProfile.yearsOfExperienceEstimated,
    cvFileName: s.cvFile?.name ?? null,
  });
  state.trystero?.send(msg, targetPeerId);
  if (s.cvFile) state.trystero?.sendFile(s.cvFile, { name: s.cvFile.name, mimeType: s.cvFile.type, kind: seekerMode === 'missionSeeker' ? 'propal' : 'cv', domain: DOMAIN_OF[seekerMode] }, targetPeerId);
}

function resetSeekerSearch(seekerMode) {
  const s = state[seekerMode];
  if (s.isLive) {
    state.trystero?.send(createIdentityRetired({ domain: DOMAIN_OF[seekerMode], retiredId: s.identity.id }));
    log(`[${seekerMode}] Recherche arrêtée.`);
  }
  const identity = s.identity;
  Object.assign(s, freshSeekerState(), { identity });
  renderSeekerUi(seekerMode);
}

function refreshPosterUi(posterMode) {
  if (state.visibleMode !== posterMode) return;
  const s = state[posterMode];
  const rooms = Array.from(s.rooms.values()).map((r) => ({
    id: r.id, title: r.title, text: r.text, unread: r.unread || 0,
    candidates: Array.from(r.ranker.scores.values()).sort((a, b) => b.total - a.total),
  }));
  if (!s.activeRoomId && rooms.length > 0) s.activeRoomId = rooms[0].id;
  POSTER_RENDER_FN[posterMode]({
    identity: s.identity, rooms, activeRoomId: s.activeRoomId,
    ...identityCallbacks(posterMode),
    onCreateRoom: (data) => createPosterRoom(posterMode, data),
    onSelectRoom: (id) => selectPosterRoom(posterMode, id),
    onOpenCandidate: (entry, room) => onOpenPosterCandidateDetail(posterMode, entry, room),
    onRemoveRoom: (id) => removePosterRoom(posterMode, id),
  });
  reopenPendingPosterDetail(posterMode);
}

async function createPosterRoom(posterMode, { title, text, city, country, minYearsRequired, maxYearsRequired }) {
  const s = state[posterMode];
  if (!city || !country || !text.trim()) { log('Ville, pays et texte sont obligatoires.'); return; }
  if (s.rooms.size >= MAX_POSTINGS_PER_RECRUITER) { log(`Limite atteinte : ${MAX_POSTINGS_PER_RECRUITER} salles maximum.`); return; }
  const roomLocalId = `room_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  log('Analyse locale (CPU, mots-clés uniquement)...');
  const doc = await parseDocument({ text, kind: 'job', id: roomLocalId });
  const { facts } = extractFacts(doc);
  const jobProfile = buildJobProfile({ documentId: roomLocalId, facts, rawText: text, minYearsRequired, maxYearsRequired, country, city });

  const finalTitle = title || text.split('\n')[0].slice(0, 60) || 'Annonce sans titre';
  const ranker = new RoomRanker(jobProfile, finalTitle);
  ranker.onRankingChange(() => refreshPosterUi(posterMode));

  s.rooms.set(roomLocalId, { id: roomLocalId, title: finalTitle, text, jobProfile, ranker, unread: 0 });
  s.activeRoomId = roomLocalId;
  const rangeNote = (minYearsRequired != null || maxYearsRequired != null) ? `, ancienneté ${minYearsRequired ?? '0'}-${maxYearsRequired ?? '∞'} an(s)` : '';
  log(`Salle publiée : « ${finalTitle} » (${jobProfile.city}, ${jobProfile.country}${rangeNote}, mots-clés : ${jobProfile.keywords.join(', ') || 'aucun'}).`);

  await ensureNetwork();
  refreshPosterUi(posterMode);
}

function removePosterRoom(posterMode, roomId) {
  const s = state[posterMode];
  s.rooms.delete(roomId);
  if (s.activeRoomId === roomId) { const remaining = Array.from(s.rooms.keys()); s.activeRoomId = remaining[0] || null; }
  log('Salle retirée.');
  refreshPosterUi(posterMode);
}

function selectPosterRoom(posterMode, roomId) {
  const s = state[posterMode];
  s.activeRoomId = roomId;
  s.openCandidateContext = null;
  const room = s.rooms.get(roomId);
  if (room) room.unread = 0;
  refreshPosterUi(posterMode);
}

function reopenPendingPosterDetail(posterMode) {
  const s = state[posterMode];
  const ctx = s.openCandidateContext;
  if (ctx && ctx.roomId === s.activeRoomId) {
    const room = s.rooms.get(ctx.roomId);
    const entry = room && Array.from(room.ranker.scores.values()).find((sc) => sc.peerId === ctx.peerId);
    if (room && entry) onOpenPosterCandidateDetail(posterMode, entry, room, { skipContextUpdate: true });
  } else if (s.openChatPeerId) {
    renderPosterChatView(posterMode);
  }
}

function onOpenPosterCandidateDetail(posterMode, entry, room, opts = {}) {
  const s = state[posterMode];
  if (!opts.skipContextUpdate) { s.openCandidateContext = { roomId: room.id, peerId: entry.peerId }; s.openChatPeerId = null; }
  renderCandidateDetail(POSTER_CFG[posterMode].detailZoneId, entry, {
    cvUrl: s.receivedCvUrls.get(entry.peerId) || null,
    onProposeContact: (note) => {
      const who = entry.displayName || entry.peerId.slice(0, 8) + '…';
      s.knownChatPeers.add(entry.peerId);
      const domain = DOMAIN_OF[posterMode];
      if (note) {
        const msg = createMeetingProposal({ domain, toPeerId: entry.peerId, roomTitle: room.title, note, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
        log(`Proposition de rendez-vous envoyée à ${who}.`);
      } else {
        const msg = createChatRequest({ domain, toPeerId: entry.peerId, roomTitle: room.title, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
        log(`Proposition de chat envoyée à ${who}.`);
      }
    },
  });
}

async function openPosterChatThread(posterMode, peerId) {
  const s = state[posterMode];
  s.openChatPeerId = peerId;
  s.openCandidateContext = null;
  await chatStore.saveThread({ peerId, createdAt: Date.now(), active: true });
  const history = await chatStore.listMessagesForPeer(peerId);
  s.openChatHistory = history.map((m) => ({ senderId: m.senderId, text: m.text, timestamp: m.timestamp }));
  renderPosterChatView(posterMode);
}

function renderPosterChatView(posterMode) {
  const s = state[posterMode];
  const conv = { id: s.openChatPeerId, status: 'active', history: s.openChatHistory || [] };
  renderConversationView(POSTER_CFG[posterMode].detailZoneId, conv, {
    onAccept: () => {}, onDecline: () => {},
    onSend: (_id, text) => sendPosterChatMessage(posterMode, text),
  });
}

function sendPosterChatMessage(posterMode, text) {
  const s = state[posterMode];
  const peerId = s.openChatPeerId;
  if (!peerId) return;
  const msg = createChatMessage({ domain: DOMAIN_OF[posterMode], toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  s.openChatHistory.push({ senderId: 'me', text: msg.text, timestamp: msg.timestamp });
  renderPosterChatView(posterMode);
}

function appendPosterChatMessage(posterMode, peerId, message) {
  const s = state[posterMode];
  if (s.openChatPeerId !== peerId) return;
  s.openChatHistory.push(message);
  renderPosterChatView(posterMode);
}

function renderSymmetricUi(mode) {
  if (state.visibleMode !== mode) return;
  const s = state[mode];
  SYMMETRIC_RENDER_FN[mode]({
    identity: s.identity, isLive: s.isLive,
    hasPhoto: Boolean(s.photoFile), profile: s.myProfile,
    analysisOpts: { boostStatus: s.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: () => boostSymmetricKeywords(mode) },
    ...identityCallbacks(mode),
    onPhotoSelected: (file) => { s.photoFile = file; log(`Photo sélectionnée : ${file.name}.`); },
    onStartLive: (data) => startSymmetricLive(mode, data),
    onResetSearch: () => resetSymmetricSearch(mode),
  });
  refreshSymmetricMatches(mode);
  const c = SYMMETRIC_CONTAINERS[mode];
  renderConversations(c.tabsId, c.convId, Array.from(s.conversations.values()), s.activeConversationId, {
    onSelect: (id) => selectConversation(mode, id),
    onAccept: (id) => acceptConversation(mode, id),
    onDecline: (id) => declineConversation(mode, id),
    onSend: (id, text) => sendConversationMessage(mode, id, text),
  });
}

async function startSymmetricLive(mode, { title, demand, city, country, extra, bio }) {
  const s = state[mode];
  const cities = parseCommaList(city);
  const countries = parseCommaList(country);
  const demandKeywords = parseCommaList(demand);
  if (cities.length === 0 || countries.length === 0 || demandKeywords.length === 0 || !bio || !bio.trim()) {
    log('Mot-clé de demande, ville, pays et description sont tous obligatoires.');
    return;
  }
  const documentId = `${mode}_${Date.now()}`;
  const doc = await parseDocument({ text: bio, kind: 'cv', id: documentId });
  const { facts } = extractFacts(doc);

  s.myProfile = buildJobProfile({ documentId, facts, rawText: bio, country: countries[0], city: cities[0] });
  s.myTitle = title?.trim() || 'Profil sans titre';
  if (mode === 'dating') s.myAge = extra ? Number(extra) : null;
  else s.myLink = extra?.trim() || null;
  s.bioRawText = bio;
  s.cities = cities; s.countries = countries; s.demandKeywords = demandKeywords;
  s.boostStatus = 'off';

  s.ranker = new RoomRanker(s.myProfile, s.myTitle);
  s.ranker.onRankingChange(() => refreshSymmetricMatches(mode));

  await ensureNetwork();
  s.isLive = true;
  broadcastSymmetricIfLive(mode);
  log(`[${mode}] En direct : « ${s.myTitle} » · ${s.cities.join(', ')} · ${s.countries.join(', ')} — profil + photo diffusés.`);
  renderSymmetricUi(mode);
}

function broadcastSymmetricIfLive(mode, targetPeerId) {
  const s = state[mode];
  if (!SYMMETRIC_RENDER_FN[mode] || !s.isLive || !s.myProfile) return;
  const msg = createCandidateBroadcast({
    domain: DOMAIN_OF[mode],
    senderId: s.identity.id, displayName: s.identity.displayName || s.myTitle,
    searchKeywords: s.demandKeywords, skills: s.myProfile.keywords,
    cities: s.cities, countries: s.countries,
    age: mode === 'dating' ? s.myAge : undefined,
    link: mode === 'service' ? s.myLink : undefined,
    cvFileName: s.photoFile?.name ?? null,
  });
  state.trystero?.send(msg, targetPeerId);
  if (s.photoFile) state.trystero?.sendFile(s.photoFile, { name: s.photoFile.name, mimeType: s.photoFile.type, kind: 'photo', domain: DOMAIN_OF[mode] }, targetPeerId);
}

async function boostSymmetricKeywords(mode) {
  const s = state[mode];
  if (!s.myProfile || !s.bioRawText) return;
  await runBoost(s, () => broadcastSymmetricIfLive(mode));
  renderSymmetricUi(mode);
}

function resetSymmetricSearch(mode) {
  const s = state[mode];
  if (s.isLive) {
    state.trystero?.send(createIdentityRetired({ domain: DOMAIN_OF[mode], retiredId: s.identity.id }));
    log(`[${mode}] Recherche arrêtée.`);
  }
  const identity = s.identity;
  Object.assign(s, freshSymmetricState(), { identity });
  renderSymmetricUi(mode);
}

function refreshSymmetricMatches(mode) {
  if (state.visibleMode !== mode) return;
  const s = state[mode];
  if (!s.ranker) { SYMMETRIC_MATCHES_FN[mode]([], { onOpen: () => {} }); return; }
  const matches = Array.from(s.ranker.scores.values()).map((sc) => ({
    ...sc, photoUrl: s.receivedPhotoUrls.get(sc.peerId) || null,
  })).sort((a, b) => b.total - a.total);
  SYMMETRIC_MATCHES_FN[mode](matches, { onOpen: (entry) => onOpenSymmetricMatch(mode, entry) });
}

function onOpenSymmetricMatch(mode, entry) {
  const s = state[mode];
  SYMMETRIC_MATCH_DETAIL_FN[mode](entry, {
    photoUrl: s.receivedPhotoUrls.get(entry.peerId) || null,
    onProposeContact: (note) => {
      const who = entry.displayName || entry.peerId.slice(0, 8) + '…';
      const domain = DOMAIN_OF[mode];
      if (note) {
        const msg = createMeetingProposal({ domain, toPeerId: entry.peerId, note, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
      } else {
        const msg = createChatRequest({ domain, toPeerId: entry.peerId, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
      }
      s.conversations.set(entry.peerId, { id: entry.peerId, peerId: entry.peerId, displayName: entry.displayName, status: 'pending', direction: 'outgoing', history: [], unread: 0 });
      log(`Proposition envoyée à ${who}.`);
      renderSymmetricUi(mode);
    },
  });
}

function selectConversation(modeKey, id) {
  const s = state[modeKey];
  s.activeConversationId = id;
  const conv = s.conversations.get(id);
  if (conv) conv.unread = 0;
  rerender(modeKey);
  refreshModeBadges();
}

async function acceptConversation(modeKey, peerId) {
  const s = state[modeKey];
  const conv = s.conversations.get(peerId);
  if (!conv) return;
  const domain = DOMAIN_OF[modeKey];
  state.trystero?.send(createChatResponse({ domain, toPeerId: peerId, requestId: conv.requestId, accepted: true }), peerId);
  conv.status = 'active';
  conv.unread = 0;
  await chatStore.saveThread({ peerId, createdAt: Date.now(), active: true });
  conv.history = (await chatStore.listMessagesForPeer(peerId)).map((m) => ({ senderId: m.senderId, text: m.text, timestamp: m.timestamp }));
  s.activeConversationId = peerId;
  rerender(modeKey);
  refreshModeBadges();
}

function declineConversation(modeKey, peerId) {
  const s = state[modeKey];
  const conv = s.conversations.get(peerId);
  if (!conv) return;
  const domain = DOMAIN_OF[modeKey];
  state.trystero?.send(createChatResponse({ domain, toPeerId: peerId, requestId: conv.requestId, accepted: false }), peerId);
  s.conversations.delete(peerId);
  if (s.activeConversationId === peerId) s.activeConversationId = null;
  rerender(modeKey);
  refreshModeBadges();
}

function sendConversationMessage(modeKey, peerId, text) {
  const s = state[modeKey];
  const conv = s.conversations.get(peerId);
  if (!conv) return;
  const domain = DOMAIN_OF[modeKey];
  const msg = createChatMessage({ domain, toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  conv.history.push({ senderId: 'me', text: msg.text, timestamp: msg.timestamp });
  rerender(modeKey);
}

function addIncomingProposal(modeKey, message, peerId, kind) {
  const s = state[modeKey];
  const conv = {
    id: peerId, peerId, requestId: message.id,
    displayName: message.fromName, status: 'pending', direction: 'incoming',
    kind, note: message.note || null, roomTitle: message.roomTitle || null,
    unread: 1, history: [],
  };
  s.conversations.set(peerId, conv);
  if (!s.activeConversationId) s.activeConversationId = peerId;
  rerender(modeKey);
  refreshModeBadges();
}

function refreshModeBadges() {
  for (const m of Object.keys(SEEKER_RENDER_FN)) setModeBadge(m, Array.from(state[m].conversations.values()).reduce((n, c) => n + (c.unread || 0), 0));
  for (const m of Object.keys(SYMMETRIC_RENDER_FN)) setModeBadge(m, Array.from(state[m].conversations.values()).reduce((n, c) => n + (c.unread || 0), 0));
  for (const m of Object.keys(POSTER_RENDER_FN)) setModeBadge(m, Array.from(state[m].rooms.values()).reduce((n, r) => n + (r.unread || 0), 0));
}

function handleIncomingMessage(message, peerId) {
  if (state.blockedPeers.has(peerId)) return;
  const domain = message.domain || Domain.JOB;
  const symmetricMode = SYMMETRIC_MODE_FOR_DOMAIN[domain];
  const seekerMode = SEEKER_MODE_FOR_DOMAIN[domain];
  const posterMode = POSTER_MODE_FOR_DOMAIN[domain];

  switch (message.type) {
    case MessageType.CANDIDATE_BROADCAST: {
      const validation = validateCandidateBroadcast({ ...message, peerId });
      if (!validation.ok) { console.warn('[main] diffusion rejetée', peerId, validation.errors); break; }
      if (symmetricMode) {
        if (state[symmetricMode].ranker) state[symmetricMode].ranker.ingestBroadcast(peerId, validation.value);
        refreshSymmetricMatches(symmetricMode);
      } else if (posterMode && state.initializedModes[posterMode]) {
        for (const room of state[posterMode].rooms.values()) room.ranker.ingestBroadcast(peerId, validation.value);
        refreshPosterUi(posterMode);
      }
      break;
    }
    case MessageType.IDENTITY_RETIRED:
      if (symmetricMode) { state[symmetricMode].ranker?.retireIdentity(message.retiredId); refreshSymmetricMatches(symmetricMode); }
      else if (posterMode) { for (const room of state[posterMode].rooms.values()) room.ranker.retireIdentity(message.retiredId); refreshPosterUi(posterMode); }
      break;
    case MessageType.CHAT_REQUEST:
    case MessageType.MEETING_PROPOSAL: {
      const kind = message.type === MessageType.MEETING_PROPOSAL ? 'meeting' : 'chat';
      const targetMode = symmetricMode || seekerMode;
      if (targetMode && state.initializedModes[targetMode]) addIncomingProposal(targetMode, message, peerId, kind);
      break;
    }
    case MessageType.CHAT_RESPONSE: {
      if (symmetricMode && state[symmetricMode].conversations.has(peerId)) {
        const conv = state[symmetricMode].conversations.get(peerId);
        if (message.accepted) { conv.status = 'active'; chatStore.saveThread({ peerId, createdAt: Date.now(), active: true }); }
        else state[symmetricMode].conversations.delete(peerId);
        rerender(symmetricMode);
      } else if (posterMode && state[posterMode].knownChatPeers.has(peerId)) {
        if (message.accepted) openPosterChatThread(posterMode, peerId);
        else log(`Proposition refusée par ${peerId.slice(0, 8)}…`);
      }
      break;
    }
    case MessageType.CHAT_MESSAGE: {
      chatStore.saveMessage({ id: message.id, peerId, senderId: peerId, timestamp: message.timestamp, text: message.text });
      if (symmetricMode && state[symmetricMode].conversations.has(peerId)) {
        const conv = state[symmetricMode].conversations.get(peerId);
        conv.history.push({ senderId: peerId, text: message.text, timestamp: message.timestamp });
        if (state[symmetricMode].activeConversationId !== peerId) conv.unread = (conv.unread || 0) + 1;
        rerender(symmetricMode); refreshModeBadges();
      } else if (seekerMode && state[seekerMode].conversations.has(peerId)) {
        const conv = state[seekerMode].conversations.get(peerId);
        conv.history.push({ senderId: peerId, text: message.text, timestamp: message.timestamp });
        if (state[seekerMode].activeConversationId !== peerId) conv.unread = (conv.unread || 0) + 1;
        rerender(seekerMode); refreshModeBadges();
      } else if (posterMode && state[posterMode].knownChatPeers.has(peerId)) {
        appendPosterChatMessage(posterMode, peerId, { senderId: peerId, text: message.text, timestamp: message.timestamp });
      }
      break;
    }
    default: break;
  }
}

function handleIncomingFile(blob, meta, peerId) {
  if (state.blockedPeers.has(peerId)) return;
  const url = URL.createObjectURL(blob);
  const domain = meta?.domain || Domain.JOB;

  if (meta?.kind === 'photo') {
    const mode = SYMMETRIC_MODE_FOR_DOMAIN[domain];
    if (!mode) return;
    const s = state[mode];
    const previous = s.receivedPhotoUrls.get(peerId);
    if (previous) URL.revokeObjectURL(previous);
    s.receivedPhotoUrls.set(peerId, url);
    log(`Photo reçue de ${peerId.slice(0, 8)}…`);
    refreshSymmetricMatches(mode);
  } else {
    const posterMode = POSTER_MODE_FOR_DOMAIN[domain];
    if (!posterMode) return;
    const s = state[posterMode];
    const previous = s.receivedCvUrls.get(peerId);
    if (previous) URL.revokeObjectURL(previous);
    s.receivedCvUrls.set(peerId, url);
    log(`Document reçu de ${peerId.slice(0, 8)}… (${meta?.name || 'fichier'}).`);
    if (s.openCandidateContext?.peerId === peerId) refreshPosterUi(posterMode);
  }
}

init();
