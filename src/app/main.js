// src/app/main.js
//
// Point d'entree. Cinq modes (Service retire), un seul VISIBLE a la fois.
// CHAQUE mode peut heberger PLUSIEURS recherches en parallele ("instances"
// - recherches pour candidat/annonceur-mission, salles pour employeur/
// client, profils pour rencontre), chacune avec son propre etat et ses
// propres conversations. Une instance seeker/symetrique diffuse sous SON
// PROPRE identifiant (senderId = instance.id) : plusieurs recherches
// simultanees sous un meme mode apparaissent comme des participants
// distincts sur le reseau, chacune trouvable independamment.

import { haversineKm } from '../core/geo.js';

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
  renderJobCandidatePanel, renderMissionSeekerPanel, renderDriveDriverPanel,
  renderJobRecruiterPanel, renderMissionClientPanel, renderDrivePassengerPanel,
  JOB_RECRUITER_CFG, MISSION_CLIENT_CFG, DRIVE_PASSENGER_CFG,
  renderCandidateDetail,
  renderDatingPanel, renderDatingMatchDetail,
  renderConversationView, renderNearPanel, renderAgentPanel, renderLog,
} from '../ui/render.js';

const AI_MODEL_ID = MODEL_CATALOG.find((m) => m.tier === 'light')?.id ?? MODEL_CATALOG[0].id;
const APP_ROOM_ID = 'jobmatch-p2p-v1';

const NAMESPACE = {
  jobCandidate: 'job_candidate', jobRecruiter: 'job_recruiter',
  missionSeeker: 'mission_seeker', missionClient: 'mission_client',
  dating: 'dating',
  driveDriver: 'drive_driver', drivePassenger: 'drive_passenger',
};
const DOMAIN_OF = {
  jobCandidate: Domain.JOB, jobRecruiter: Domain.JOB,
  missionSeeker: Domain.MISSION, missionClient: Domain.MISSION,
  dating: Domain.DATING,
  driveDriver: Domain.DRIVE, drivePassenger: Domain.DRIVE,
};
const SEEKER_MODE_FOR_DOMAIN = { [Domain.JOB]: 'jobCandidate', [Domain.MISSION]: 'missionSeeker', [Domain.DRIVE]: 'driveDriver' };
const POSTER_MODE_FOR_DOMAIN = { [Domain.JOB]: 'jobRecruiter', [Domain.MISSION]: 'missionClient', [Domain.DRIVE]: 'drivePassenger' };
const SYMMETRIC_MODE_FOR_DOMAIN = { [Domain.DATING]: 'dating' };

const SEEKER_RENDER_FN = { jobCandidate: renderJobCandidatePanel, missionSeeker: renderMissionSeekerPanel, driveDriver: renderDriveDriverPanel };
const POSTER_RENDER_FN = { jobRecruiter: renderJobRecruiterPanel, missionClient: renderMissionClientPanel, drivePassenger: renderDrivePassengerPanel };
const POSTER_CFG = { jobRecruiter: JOB_RECRUITER_CFG, missionClient: MISSION_CLIENT_CFG, drivePassenger: DRIVE_PASSENGER_CFG };
const SYMMETRIC_RENDER_FN = { dating: renderDatingPanel };

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

function freshDraft() { return { localProfile: null, cvFile: null, cvRawText: null }; }
function freshSeekerModeState() { return { identity: null, instances: new Map(), activeInstanceId: null, creatingNew: false, draft: freshDraft() }; }
function freshPosterModeState() {
  return {
    identity: null, rooms: new Map(), activeRoomId: null, creatingNew: false,
    receivedCvUrls: new Map(), knownChatPeers: new Set(),
    openCandidateContext: null, openChatPeerId: null, openChatHistory: [],
  };
}
function freshSymmetricModeState() { return { identity: null, instances: new Map(), activeInstanceId: null, creatingNew: false, draft: {} }; }

const state = {
  webgpuAvailable: false,
  trystero: null,
  blockedPeers: new Set(),
  visibleMode: null,
  initializedModes: { jobCandidate: false, jobRecruiter: false, missionSeeker: false, missionClient: false, dating: false, driveDriver: false, drivePassenger: false },

  jobCandidate: freshSeekerModeState(),
  missionSeeker: freshSeekerModeState(),
  driveDriver: freshSeekerModeState(),
  jobRecruiter: freshPosterModeState(),
  missionClient: freshPosterModeState(),
  drivePassenger: freshPosterModeState(),
  dating: freshSymmetricModeState(),

  near: { myLat: null, myLng: null, accuracy: null, radiusKm: 20, watchId: null },
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

  if (mode === 'near') { renderNearUi(); log('Mode near affiché.'); return; }
  if (mode === 'agent') { renderAgentUi(); log('Mode agent affiché.'); return; }

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
      for (const m of Object.keys(SEEKER_RENDER_FN)) for (const inst of state[m].instances.values()) broadcastSeekerInstance(m, inst, peerId);
      for (const m of Object.keys(SYMMETRIC_RENDER_FN)) for (const inst of state[m].instances.values()) broadcastSymmetricInstance(m, inst, peerId);
    });
    state.trystero.onPeerLeave((peerId) => {
      log(`Pair déconnecté : ${peerId.slice(0, 8)}…`);
      for (const m of Object.keys(POSTER_RENDER_FN)) { for (const room of state[m].rooms.values()) room.ranker.removePeer(peerId); refreshPosterUi(m); }
      for (const m of Object.keys(SYMMETRIC_RENDER_FN)) { for (const inst of state[m].instances.values()) inst.ranker?.removePeer(peerId); renderSymmetricUi(m); }
    });
  } catch (e) {
    log(`Réseau P2P indisponible (${e.message}).`);
  }
}

/** Geolocalisation du navigateur, strictement a la demande (jamais automatique). */
function requestGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('geolocalisation indisponible dans ce navigateur')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(new Error(err.message || 'refusee')),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  });
}

function identityCallbacks(modeKey) {
  const namespace = NAMESPACE[modeKey];
  return {
    onSaveName: async (name) => {
      state[modeKey].identity = await identityStore.setDisplayName(namespace, name);
      log(`[${modeKey}] Nom mis à jour.`);
      rerender(modeKey);
    },
    onRestoreId: async (id) => {
      try {
        state[modeKey].identity = await identityStore.restoreIdentity(namespace, id);
        log(`[${modeKey}] Identité restaurée : id ${state[modeKey].identity.id}.`);
        rerender(modeKey);
      } catch (e) {
        log(`Restauration impossible : ${e.message}`);
      }
    },
    onInvalidateId: async () => {
      state[modeKey].identity = await identityStore.regenerateId(namespace);
      log(`[${modeKey}] ID invalidé. Nouvel ID : ${state[modeKey].identity.id}.`);
      rerender(modeKey);
    },
    onWipeMode: () => wipeModeData(modeKey),
  };
}

async function wipeModeData(modeKey) {
  const s = state[modeKey];
  const namespace = NAMESPACE[modeKey];
  const domain = DOMAIN_OF[modeKey];
  const peerIds = new Set();

  if (SEEKER_RENDER_FN[modeKey] || SYMMETRIC_RENDER_FN[modeKey]) {
    for (const inst of s.instances.values()) {
      if (inst.isLive) state.trystero?.send(createIdentityRetired({ domain, retiredId: inst.id }));
      for (const peerId of inst.conversations.keys()) peerIds.add(peerId);
    }
    Object.assign(s, modeKey === 'dating' ? freshSymmetricModeState() : freshSeekerModeState(), { identity: null });
  } else if (POSTER_RENDER_FN[modeKey]) {
    for (const peerId of s.knownChatPeers) peerIds.add(peerId);
    Object.assign(s, freshPosterModeState(), { identity: null });
  }
  await Promise.all(Array.from(peerIds).map((peerId) => chatStore.deleteThread(peerId).catch(() => {})));

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
  const instances = Array.from(s.instances.values()).map((inst) => ({
    id: inst.id,
    searchKeywords: inst.searchKeywords,
    boostStatus: inst.boostStatus,
    conversations: Array.from(inst.conversations.values()),
    activeConversationId: inst.activeConversationId,
    unread: Array.from(inst.conversations.values()).reduce((n, c) => n + (c.unread || 0), 0),
  }));
  SEEKER_RENDER_FN[seekerMode]({
    identity: s.identity,
    ...identityCallbacks(seekerMode),
    creatingNew: s.creatingNew,
    instances, activeInstanceId: s.activeInstanceId,
    onSelectInstance: (id) => { s.activeInstanceId = id; markSeekerConversationsRead(seekerMode, id); renderSeekerUi(seekerMode); refreshModeBadges(); },
    onRequestNew: () => { s.creatingNew = true; s.draft = freshDraft(); renderSeekerUi(seekerMode); },
    onFileSelected: (file, onDone) => analyzeSeekerFile(seekerMode, file, onDone),
    onLaunch: (data) => launchSeekerInstance(seekerMode, data),
    onBoost: (id) => boostSeekerInstance(seekerMode, id),
    onResetInstance: (id) => resetSeekerInstance(seekerMode, id),
    onSelectConversation: (instId, convId) => selectConversation(seekerMode, instId, convId),
    onAcceptConversation: (instId, convId) => acceptConversation(seekerMode, instId, convId),
    onDeclineConversation: (instId, convId) => declineConversation(seekerMode, instId, convId),
    onSendMessage: (instId, convId, text) => sendConversationMessage(seekerMode, instId, convId, text),
    onRequestLocation: requestGeolocation,
  });
}

function markSeekerConversationsRead(mode, instanceId) {
  const inst = state[mode].instances.get(instanceId);
  if (!inst) return;
  const conv = inst.conversations.get(inst.activeConversationId);
  if (conv) conv.unread = 0;
}

async function analyzeSeekerFile(seekerMode, file, onDone) {
  const s = state[seekerMode];
  const documentId = `${seekerMode}_draft_${Date.now()}`;
  const kindLabel = seekerMode === 'missionSeeker' ? 'propal' : 'CV';
  log(`Analyse locale du ${kindLabel} (CPU, mots-clés uniquement)...`);

  let mammothLib = null;
  if (file.name.toLowerCase().endsWith('.docx')) {
    try { mammothLib = await loadMammothBrowserBundle(); }
    catch (e) { log(`Lecture du .docx impossible (${e.message}). Utilisez un .txt en attendant.`); return; }
  }
  const doc = await parseDocument({ file, kind: 'cv', id: documentId, mammothLib });
  const { facts } = extractFacts(doc);
  s.draft.localProfile = buildCandidateProfile({ documentId, facts });
  s.draft.cvFile = file;
  s.draft.cvRawText = doc.rawText;

  log(`Mots-clés extraits : ${s.draft.localProfile.keywords.join(', ') || '(aucun détecté)'}.`);
  onDone();
}

async function launchSeekerInstance(seekerMode, data) {
  const s = state[seekerMode];
  const kindLabel = seekerMode === 'missionSeeker' ? 'propal' : 'CV';
  if (!s.draft.localProfile || !s.draft.cvFile) { log(`Déposez et laissez analyser votre ${kindLabel} avant de lancer.`); return; }
  const keywords = parseCommaList(data.keywords);
  const cities = parseCommaList(data.city);
  const countries = parseCommaList(data.country);
  if (keywords.length === 0 || cities.length === 0 || countries.length === 0) { log('Mot-clé, ville et pays sont tous obligatoires.'); return; }

  const localProfile = s.draft.localProfile;
  if (seekerMode === 'missionSeeker') {
    if (!data.extraText || !data.extraText.trim()) { log('Le texte de l\'offre est obligatoire.'); return; }
    const doc = await parseDocument({ text: data.extraText, kind: 'cv', id: `${localProfile.id}_extra` });
    const { facts } = extractFacts(doc);
    const extra = buildCandidateProfile({ documentId: localProfile.id, facts });
    const existing = new Set(localProfile.keywords);
    for (const kw of extra.keywords) if (!existing.has(kw)) { existing.add(kw); localProfile.keywords.push(kw); }
  }

  const id = `${seekerMode}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  const instance = {
    id, localProfile, cvFile: s.draft.cvFile, cvRawText: s.draft.cvRawText,
    searchKeywords: keywords, cities, countries,
    price: data.price ? data.price.trim() || null : null,
    lat: typeof data.lat === 'number' ? data.lat : null,
    lng: typeof data.lng === 'number' ? data.lng : null,
    boostStatus: 'off', isLive: true,
    conversations: new Map(), activeConversationId: null,
  };
  s.instances.set(id, instance);
  s.activeInstanceId = id;
  s.creatingNew = false;
  s.draft = freshDraft();

  await ensureNetwork();
  broadcastSeekerInstance(seekerMode, instance);
  log(`[${seekerMode}] En direct : "${keywords.join(', ')}" · ${cities.join(', ')} · ${countries.join(', ')} — document diffusé.`);
  renderSeekerUi(seekerMode);
}

function broadcastSeekerInstance(seekerMode, instance, targetPeerId) {
  if (!instance.isLive) return;
  const s = state[seekerMode];
  const msg = createCandidateBroadcast({
    domain: DOMAIN_OF[seekerMode],
    senderId: instance.id, displayName: s.identity?.displayName,
    searchKeywords: instance.searchKeywords, skills: instance.localProfile.keywords,
    cities: instance.cities, countries: instance.countries,
    yearsOfExperience: instance.localProfile.yearsOfExperience,
    yearsOfExperienceEstimated: instance.localProfile.yearsOfExperienceEstimated,
    cvFileName: instance.cvFile?.name ?? null,
    lat: instance.lat, lng: instance.lng,
  });
  state.trystero?.send(msg, targetPeerId);
  if (instance.cvFile) state.trystero?.sendFile(instance.cvFile, { name: instance.cvFile.name, mimeType: instance.cvFile.type, kind: seekerMode === 'missionSeeker' ? 'propal' : 'cv', domain: DOMAIN_OF[seekerMode] }, targetPeerId);
}

async function boostSeekerInstance(seekerMode, instanceId) {
  const inst = state[seekerMode].instances.get(instanceId);
  if (!inst || !inst.cvRawText) return;
  await runBoost(inst, () => broadcastSeekerInstance(seekerMode, inst));
  renderSeekerUi(seekerMode);
}

async function runBoost(entity, onDone) {
  if (!state.webgpuAvailable) { log('WebGPU indisponible : boost impossible.'); return; }
  entity.boostStatus = 'loading';
  try {
    await llm.loadModel(AI_MODEL_ID);
    const cvText = entity.cvRawText ?? entity.bioRawText ?? '';
    const target = entity.localProfile ?? entity.myProfile;
    const result = await llm.boostKeywords({ cvText, currentKeywords: target?.keywords ?? [] });
    if (result.ok && result.keywords.length > 0 && target) {
      const existing = new Set(target.keywords);
      let added = 0;
      for (const raw of result.keywords) {
        const { normalized } = normalizeSkill(raw);
        if (normalized && !existing.has(normalized)) { existing.add(normalized); target.keywords.push(normalized); added += 1; }
      }
      entity.boostStatus = 'done';
      log(`Boost IA : ${added} mot(s)-clé(s) ajouté(s) (${result.keywords.join(', ')}).`);
    } else {
      entity.boostStatus = 'error';
      log('Boost IA : aucune suggestion exploitable.');
    }
  } catch (e) {
    entity.boostStatus = 'error';
    log(`Boost IA indisponible (${e.message}).`);
  }
  onDone?.();
}

function resetSeekerInstance(seekerMode, instanceId) {
  const s = state[seekerMode];
  const inst = s.instances.get(instanceId);
  if (!inst) return;
  if (inst.isLive) state.trystero?.send(createIdentityRetired({ domain: DOMAIN_OF[seekerMode], retiredId: inst.id }));
  s.instances.delete(instanceId);
  if (s.activeInstanceId === instanceId) s.activeInstanceId = Array.from(s.instances.keys())[0] || null;
  log(`[${seekerMode}] Recherche arrêtée et retirée.`);
  renderSeekerUi(seekerMode);
  refreshModeBadges();
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
    identity: s.identity,
    ...identityCallbacks(posterMode),
    creatingNew: s.creatingNew,
    rooms, activeRoomId: s.activeRoomId,
    onSelectRoom: (id) => { s.activeRoomId = id; const r = s.rooms.get(id); if (r) r.unread = 0; refreshPosterUi(posterMode); refreshModeBadges(); },
    onRequestNew: () => { s.creatingNew = true; refreshPosterUi(posterMode); },
    onCreateRoom: (data) => createPosterRoom(posterMode, data),
    onOpenCandidate: (roomId, entry) => onOpenPosterCandidateDetail(posterMode, roomId, entry),
    onRemoveRoom: (id) => removePosterRoom(posterMode, id),
    onBodyMounted: () => reopenPendingPosterDetail(posterMode),
  });
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
  s.creatingNew = false;
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

function reopenPendingPosterDetail(posterMode) {
  const s = state[posterMode];
  const ctx = s.openCandidateContext;
  if (ctx && ctx.roomId === s.activeRoomId) {
    const room = s.rooms.get(ctx.roomId);
    const entry = room && Array.from(room.ranker.scores.values()).find((sc) => sc.peerId === ctx.peerId);
    if (room && entry) onOpenPosterCandidateDetail(posterMode, room.id, entry, { skipContextUpdate: true });
  } else if (s.openChatPeerId) {
    renderPosterChatView(posterMode);
  }
}

function onOpenPosterCandidateDetail(posterMode, roomId, entry, opts = {}) {
  const s = state[posterMode];
  const room = s.rooms.get(roomId);
  if (!opts.skipContextUpdate) { s.openCandidateContext = { roomId, peerId: entry.peerId }; s.openChatPeerId = null; }
  renderCandidateDetail(`${POSTER_CFG[posterMode].containerId}-detail`, entry, {
    cvUrl: s.receivedCvUrls.get(entry.peerId) || null,
    onProposeContact: (note) => {
      const who = entry.displayName || entry.peerId.slice(0, 8) + '…';
      s.knownChatPeers.add(entry.peerId);
      const domain = DOMAIN_OF[posterMode];
      if (note) {
        const msg = createMeetingProposal({ domain, toPeerId: entry.peerId, toInstanceId: entry.identityKey, roomTitle: room?.title, note, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
        log(`Proposition de rendez-vous envoyée à ${who}.`);
      } else {
        const msg = createChatRequest({ domain, toPeerId: entry.peerId, toInstanceId: entry.identityKey, roomTitle: room?.title, fromName: s.identity.displayName, fromId: s.identity.id });
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
  renderConversationView(`${POSTER_CFG[posterMode].containerId}-detail`, conv, {
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
  const instances = Array.from(s.instances.values()).map((inst) => ({
    id: inst.id, myTitle: inst.myTitle, boostStatus: inst.boostStatus,
    matches: inst.ranker ? Array.from(inst.ranker.scores.values()).map((sc) => ({ ...sc, photoUrl: inst.receivedPhotoUrls.get(sc.peerId) || null })).sort((a, b) => b.total - a.total) : [],
  }));
  SYMMETRIC_RENDER_FN[mode]({
    identity: s.identity,
    ...identityCallbacks(mode),
    creatingNew: s.creatingNew,
    instances, activeInstanceId: s.activeInstanceId,
    onSelectInstance: (id) => { s.activeInstanceId = id; renderSymmetricUi(mode); },
    onRequestNew: () => { s.creatingNew = true; renderSymmetricUi(mode); },
    onPhotoSelected: (file) => { s.draft.photoFile = file; log(`Photo sélectionnée : ${file.name}.`); },
    onLaunch: (data) => launchSymmetricInstance(mode, data),
    onBoost: (id) => boostSymmetricInstance(mode, id),
    onResetInstance: (id) => resetSymmetricInstance(mode, id),
    onOpenMatch: (instId, entry) => onOpenSymmetricMatch(mode, instId, entry),
    onRequestLocation: requestGeolocation,
  });
}

async function launchSymmetricInstance(mode, { title, demand, city, country, age, bio, lat, lng }) {
  const s = state[mode];
  const cities = parseCommaList(city);
  const countries = parseCommaList(country);
  const demandKeywords = parseCommaList(demand);
  if (cities.length === 0 || countries.length === 0 || demandKeywords.length === 0 || !bio || !bio.trim()) {
    log('Mot-clé de demande, ville, pays et description sont tous obligatoires.');
    return;
  }
  const id = `${mode}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  const doc = await parseDocument({ text: bio, kind: 'cv', id });
  const { facts } = extractFacts(doc);

  const myProfile = buildJobProfile({ documentId: id, facts, rawText: bio, country: countries[0], city: cities[0] });
  const instance = {
    id, myProfile, myTitle: title?.trim() || 'Profil sans titre', myAge: age ? Number(age) : null,
    photoFile: s.draft.photoFile || null, bioRawText: bio,
    lat: typeof lat === 'number' ? lat : null, lng: typeof lng === 'number' ? lng : null,
    ranker: null, demandKeywords, cities, countries,
    boostStatus: 'off', isLive: true, receivedPhotoUrls: new Map(),
    conversations: new Map(), activeConversationId: null,
  };
  instance.ranker = new RoomRanker(myProfile, instance.myTitle);
  instance.ranker.onRankingChange(() => renderSymmetricUi(mode));

  s.instances.set(id, instance);
  s.activeInstanceId = id;
  s.creatingNew = false;
  s.draft = {};

  await ensureNetwork();
  broadcastSymmetricInstance(mode, instance);
  log(`[${mode}] En direct : « ${instance.myTitle} » · ${cities.join(', ')} · ${countries.join(', ')} — profil + photo diffusés.`);
  renderSymmetricUi(mode);
}

function broadcastSymmetricInstance(mode, instance, targetPeerId) {
  if (!instance.isLive) return;
  const s = state[mode];
  const msg = createCandidateBroadcast({
    domain: DOMAIN_OF[mode],
    senderId: instance.id, displayName: s.identity?.displayName || instance.myTitle,
    searchKeywords: instance.demandKeywords, skills: instance.myProfile.keywords,
    cities: instance.cities, countries: instance.countries,
    age: instance.myAge,
    lat: instance.lat, lng: instance.lng,
    cvFileName: instance.photoFile?.name ?? null,
  });
  state.trystero?.send(msg, targetPeerId);
  if (instance.photoFile) state.trystero?.sendFile(instance.photoFile, { name: instance.photoFile.name, mimeType: instance.photoFile.type, kind: 'photo', domain: DOMAIN_OF[mode] }, targetPeerId);
}

async function boostSymmetricInstance(mode, instanceId) {
  const inst = state[mode].instances.get(instanceId);
  if (!inst || !inst.bioRawText) return;
  await runBoost(inst, () => broadcastSymmetricInstance(mode, inst));
  renderSymmetricUi(mode);
}

function resetSymmetricInstance(mode, instanceId) {
  const s = state[mode];
  const inst = s.instances.get(instanceId);
  if (!inst) return;
  if (inst.isLive) state.trystero?.send(createIdentityRetired({ domain: DOMAIN_OF[mode], retiredId: inst.id }));
  s.instances.delete(instanceId);
  if (s.activeInstanceId === instanceId) s.activeInstanceId = Array.from(s.instances.keys())[0] || null;
  log(`[${mode}] Profil arrêté et retiré.`);
  renderSymmetricUi(mode);
  refreshModeBadges();
}

function onOpenSymmetricMatch(mode, instanceId, entry) {
  const s = state[mode];
  const inst = s.instances.get(instanceId);
  renderDatingMatchDetail(instanceId, entry, {
    photoUrl: inst?.receivedPhotoUrls.get(entry.peerId) || null,
    onProposeContact: (note) => {
      const who = entry.displayName || entry.peerId.slice(0, 8) + '…';
      const domain = DOMAIN_OF[mode];
      if (note) {
        const msg = createMeetingProposal({ domain, toPeerId: entry.peerId, toInstanceId: entry.identityKey, note, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
      } else {
        const msg = createChatRequest({ domain, toPeerId: entry.peerId, toInstanceId: entry.identityKey, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
      }
      if (inst) {
        inst.conversations.set(entry.peerId, { id: entry.peerId, peerId: entry.peerId, displayName: entry.displayName, status: 'pending', direction: 'outgoing', history: [], unread: 0 });
        log(`Proposition envoyée à ${who}.`);
      }
    },
  });
}

function findInstanceWithConversation(mode, peerId) {
  const s = state[mode];
  for (const inst of s.instances.values()) {
    if (inst.conversations.has(peerId)) return inst;
  }
  return null;
}

function selectConversation(mode, instanceId, peerId) {
  const inst = state[mode].instances.get(instanceId);
  if (!inst) return;
  state[mode].activeInstanceId = instanceId;
  inst.activeConversationId = peerId;
  const conv = inst.conversations.get(peerId);
  if (conv) conv.unread = 0;
  rerender(mode);
  refreshModeBadges();
}

async function acceptConversation(mode, instanceId, peerId) {
  const inst = state[mode].instances.get(instanceId);
  const conv = inst?.conversations.get(peerId);
  if (!conv) return;
  const domain = DOMAIN_OF[mode];
  state.trystero?.send(createChatResponse({ domain, toPeerId: peerId, requestId: conv.requestId, accepted: true }), peerId);
  conv.status = 'active';
  conv.unread = 0;
  await chatStore.saveThread({ peerId, createdAt: Date.now(), active: true });
  conv.history = (await chatStore.listMessagesForPeer(peerId)).map((m) => ({ senderId: m.senderId, text: m.text, timestamp: m.timestamp }));
  inst.activeConversationId = peerId;
  rerender(mode);
  refreshModeBadges();
}

function declineConversation(mode, instanceId, peerId) {
  const inst = state[mode].instances.get(instanceId);
  const conv = inst?.conversations.get(peerId);
  if (!conv) return;
  const domain = DOMAIN_OF[mode];
  state.trystero?.send(createChatResponse({ domain, toPeerId: peerId, requestId: conv.requestId, accepted: false }), peerId);
  inst.conversations.delete(peerId);
  if (inst.activeConversationId === peerId) inst.activeConversationId = null;
  rerender(mode);
  refreshModeBadges();
}

function sendConversationMessage(mode, instanceId, peerId, text) {
  const inst = state[mode].instances.get(instanceId);
  const conv = inst?.conversations.get(peerId);
  if (!conv) return;
  const domain = DOMAIN_OF[mode];
  const msg = createChatMessage({ domain, toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  conv.history.push({ senderId: 'me', text: msg.text, timestamp: msg.timestamp });
  rerender(mode);
}

function addIncomingProposal(mode, message, peerId, kind) {
  const s = state[mode];
  const targetInstance = (message.toInstanceId && s.instances.get(message.toInstanceId)) || s.instances.values().next().value;
  if (!targetInstance) return;
  const conv = {
    id: peerId, peerId, requestId: message.id,
    displayName: message.fromName, status: 'pending', direction: 'incoming',
    kind, note: message.note || null, roomTitle: message.roomTitle || null,
    unread: 1, history: [],
  };
  targetInstance.conversations.set(peerId, conv);
  if (!targetInstance.activeConversationId) targetInstance.activeConversationId = peerId;
  s.activeInstanceId = targetInstance.id;
  rerender(mode);
  refreshModeBadges();
}

function refreshModeBadges() {
  for (const m of Object.keys(SEEKER_RENDER_FN)) {
    let n = 0;
    for (const inst of state[m].instances.values()) for (const c of inst.conversations.values()) n += c.unread || 0;
    setModeBadge(m, n);
  }
  for (const m of Object.keys(SYMMETRIC_RENDER_FN)) {
    let n = 0;
    for (const inst of state[m].instances.values()) for (const c of inst.conversations.values()) n += c.unread || 0;
    setModeBadge(m, n);
  }
  for (const m of Object.keys(POSTER_RENDER_FN)) {
    let n = 0;
    for (const r of state[m].rooms.values()) n += r.unread || 0;
    setModeBadge(m, n);
  }
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
      if (symmetricMode && state.initializedModes[symmetricMode]) {
        for (const inst of state[symmetricMode].instances.values()) inst.ranker?.ingestBroadcast(peerId, validation.value);
        renderSymmetricUi(symmetricMode);
      } else if (posterMode && state.initializedModes[posterMode]) {
        for (const room of state[posterMode].rooms.values()) room.ranker.ingestBroadcast(peerId, validation.value);
        refreshPosterUi(posterMode);
      }
      break;
    }
    case MessageType.IDENTITY_RETIRED:
      if (symmetricMode) { for (const inst of state[symmetricMode].instances.values()) inst.ranker?.retireIdentity(message.retiredId); renderSymmetricUi(symmetricMode); }
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
      const targetMode = symmetricMode || seekerMode;
      const inst = targetMode && findInstanceWithConversation(targetMode, peerId);
      if (inst) {
        const conv = inst.conversations.get(peerId);
        if (message.accepted) { conv.status = 'active'; chatStore.saveThread({ peerId, createdAt: Date.now(), active: true }); }
        else inst.conversations.delete(peerId);
        rerender(targetMode);
      } else if (posterMode && state[posterMode].knownChatPeers.has(peerId)) {
        if (message.accepted) openPosterChatThread(posterMode, peerId);
        else log(`Proposition refusée par ${peerId.slice(0, 8)}…`);
      }
      break;
    }
    case MessageType.CHAT_MESSAGE: {
      chatStore.saveMessage({ id: message.id, peerId, senderId: peerId, timestamp: message.timestamp, text: message.text });
      const targetMode = symmetricMode || seekerMode;
      const inst = targetMode && findInstanceWithConversation(targetMode, peerId);
      if (inst) {
        const conv = inst.conversations.get(peerId);
        conv.history.push({ senderId: peerId, text: message.text, timestamp: message.timestamp });
        if (inst.activeConversationId !== peerId) conv.unread = (conv.unread || 0) + 1;
        rerender(targetMode); refreshModeBadges();
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
    for (const inst of state[mode].instances.values()) {
      const previous = inst.receivedPhotoUrls.get(peerId);
      if (previous) URL.revokeObjectURL(previous);
      inst.receivedPhotoUrls.set(peerId, url);
    }
    log(`Photo reçue de ${peerId.slice(0, 8)}…`);
    renderSymmetricUi(mode);
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

// =====================================================================
// Near — agrège les résultats déjà découverts (salles employeur/client/
// passager, profils rencontre) dans un rayon géographique. Localisation
// strictement à la demande, jamais automatique ; ne filtre que les
// résultats dont l'AUTRE côté a lui-même choisi de partager sa position
// (§ P2P sans serveur : pas de géocodage, pas d'annuaire tiers).
// =====================================================================

const NEAR_MODE_LABEL = { jobRecruiter: 'Employeur', missionClient: 'Client', drivePassenger: 'Passager', dating: 'Rencontre' };

async function locateNear() {
  try {
    const { lat, lng, accuracy } = await requestGeolocation();
    state.near.myLat = lat; state.near.myLng = lng; state.near.accuracy = accuracy;
    log('Position partagée pour Near.');
  } catch (e) {
    log(`Localisation impossible (${e.message}).`);
  }
  renderNearUi();
}

function stopLocatingNear() {
  state.near.myLat = null; state.near.myLng = null; state.near.accuracy = null;
  log('Localisation Near arrêtée.');
  renderNearUi();
}

function computeNearEntries() {
  if (state.near.myLat == null) return [];
  const out = [];
  for (const m of Object.keys(POSTER_RENDER_FN)) {
    if (!state.initializedModes[m]) continue;
    for (const room of state[m].rooms.values()) {
      for (const c of room.ranker.scores.values()) {
        if (typeof c.lat !== 'number' || typeof c.lng !== 'number') continue;
        const d = haversineKm(state.near.myLat, state.near.myLng, c.lat, c.lng);
        if (d == null || d > state.near.radiusKm) continue;
        out.push({ distanceKm: d, label: c.displayName || `Pair ${String(c.peerId).slice(0, 8)}…`, modeLabel: NEAR_MODE_LABEL[m], subLabel: room.title, mode: m, roomId: room.id, entry: c });
      }
    }
  }
  for (const m of Object.keys(SYMMETRIC_RENDER_FN)) {
    if (!state.initializedModes[m]) continue;
    for (const inst of state[m].instances.values()) {
      if (!inst.ranker) continue;
      for (const match of inst.ranker.scores.values()) {
        if (typeof match.lat !== 'number' || typeof match.lng !== 'number') continue;
        const d = haversineKm(state.near.myLat, state.near.myLng, match.lat, match.lng);
        if (d == null || d > state.near.radiusKm) continue;
        out.push({ distanceKm: d, label: match.displayName || `Pair ${String(match.peerId).slice(0, 8)}…`, modeLabel: NEAR_MODE_LABEL[m], subLabel: inst.myTitle, mode: m, instanceId: inst.id, entry: match });
      }
    }
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

function openNearEntry(entry) {
  state.visibleMode = entry.mode;
  setVisibleMode(entry.mode);
  if (POSTER_RENDER_FN[entry.mode]) {
    state[entry.mode].activeRoomId = entry.roomId;
    refreshPosterUi(entry.mode);
    onOpenPosterCandidateDetail(entry.mode, entry.roomId, entry.entry);
  } else if (SYMMETRIC_RENDER_FN[entry.mode]) {
    state[entry.mode].activeInstanceId = entry.instanceId;
    renderSymmetricUi(entry.mode);
    onOpenSymmetricMatch(entry.mode, entry.instanceId, entry.entry);
  }
  log(`Ouverture depuis Near : ${entry.label}.`);
}

function renderNearUi() {
  renderNearPanel({
    myLat: state.near.myLat, myLng: state.near.myLng, accuracy: state.near.accuracy,
    radiusKm: state.near.radiusKm,
    entries: computeNearEntries(),
    onLocate: locateNear,
    onStopLocating: stopLocatingNear,
    onRadiusChange: (km) => { state.near.radiusKm = km; renderNearUi(); },
    onOpen: openNearEntry,
  });
}

// =====================================================================
// Agent — prototype simple à base de règles (PAS une IA) : parcourt ce
// qui est déjà actif dans les autres modes et suggère des actions.
// À enrichir plus tard (graphes de recherche, opérations proposées).
// =====================================================================

const AGENT_SEEKER_LABEL = { jobCandidate: 'candidat', missionSeeker: 'annonceur (mission)', driveDriver: 'conducteur' };
const AGENT_POSTER_LABEL = { jobRecruiter: 'employeur', missionClient: 'client', drivePassenger: 'passager' };

function computeAgentSuggestions() {
  const suggestions = [];

  for (const m of Object.keys(SEEKER_RENDER_FN)) {
    if (!state.initializedModes[m]) continue;
    for (const inst of state[m].instances.values()) {
      const unread = Array.from(inst.conversations.values()).reduce((n, c) => n + (c.unread || 0), 0);
      if (unread > 0) {
        suggestions.push({
          text: `Vous avez ${unread} message(s) non lu(s) sur une recherche ${AGENT_SEEKER_LABEL[m]} ("${inst.searchKeywords.join(', ')}").`,
          actionLabel: 'Ouvrir', onAction: () => { state.visibleMode = m; setVisibleMode(m); state[m].activeInstanceId = inst.id; renderSeekerUi(m); },
        });
      }
    }
  }

  for (const m of Object.keys(POSTER_RENDER_FN)) {
    if (!state.initializedModes[m]) continue;
    for (const room of state[m].rooms.values()) {
      const count = room.ranker.scores.size;
      if (count > 0) {
        suggestions.push({
          text: `« ${room.title} » (${AGENT_POSTER_LABEL[m]}) a ${count} profil(s) correspondant(s) à examiner.`,
          actionLabel: 'Voir', onAction: () => { state.visibleMode = m; setVisibleMode(m); state[m].activeRoomId = room.id; refreshPosterUi(m); },
        });
      } else if (room.jobProfile.keywords.length > 0) {
        suggestions.push({ text: `« ${room.title} » (${AGENT_POSTER_LABEL[m]}) n'a encore aucun profil correspondant — envisagez d'élargir les mots-clés ou la fourchette d'ancienneté.` });
      }
    }
  }

  for (const m of Object.keys(SYMMETRIC_RENDER_FN)) {
    if (!state.initializedModes[m]) continue;
    for (const inst of state[m].instances.values()) {
      const count = inst.ranker ? inst.ranker.scores.size : 0;
      if (count > 0) {
        suggestions.push({
          text: `« ${inst.myTitle} » a ${count} profil(s) compatible(s).`,
          actionLabel: 'Voir', onAction: () => { state.visibleMode = m; setVisibleMode(m); state[m].activeInstanceId = inst.id; renderSymmetricUi(m); },
        });
      }
    }
  }

  return suggestions;
}

function renderAgentUi() {
  renderAgentPanel({ suggestions: computeAgentSuggestions() });
}

init();
