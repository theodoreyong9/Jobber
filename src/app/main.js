// src/app/main.js
//
// Point d'entree. Trois modes CUMULABLES, chacun avec sa propre identite :
//   - jobCandidate : mots-cles + ville(s) obligatoire(s) + pays + CV, boost IA optionnel
//   - jobRecruiter : salles d'annonce (titre, anciennete min/max, pays, texte), CPU seul
//   - dating       : profil (intitule, ville, pays, texte, photo) + demande, boost IA optionnel
//
// Une seule connexion P2P partagee ; chaque message est tague `domain`
// ('job' | 'dating') pour que les modes ne se melangent jamais.

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
import { wipeAllLocalData } from '../storage/idb.js';
import { validateCandidateBroadcast } from '../core/validation/schema.js';

import * as llm from '../llm/provider.js';
import { MODEL_CATALOG } from '../models/catalog.js';

import {
  renderShell, setModeVisibility, renderGlobalSettings,
  renderJobCandidatePanel, renderCvAnalysisSection,
  renderJobRecruiterPanel, renderCandidateDetail,
  renderDatingPanel, renderDatingMatches, renderDatingMatchDetail,
  renderConversationTabs, renderConversationView,
  renderLog,
} from '../ui/render.js';

const AI_MODEL_ID = MODEL_CATALOG.find((m) => m.tier === 'light')?.id ?? MODEL_CATALOG[0].id;
const APP_ROOM_ID = 'jobmatch-p2p-v1';

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

const state = {
  webgpuAvailable: false,
  trystero: null,
  blockedPeers: new Set(),
  enabledModes: { jobCandidate: false, jobRecruiter: false, dating: false },

  jobCandidate: {
    identity: null, localProfile: null, cvFile: null, cvRawText: null,
    searchKeywords: [], cities: [], countries: [],
    boostStatus: 'off', isLive: false,
    conversations: new Map(), activeConversationId: null,
  },

  jobRecruiter: {
    identity: null, rooms: new Map(), activeRoomId: null,
    openCandidateContext: null, receivedCvUrls: new Map(), knownChatPeers: new Set(),
    openChatPeerId: null, openChatHistory: [],
  },

  dating: {
    identity: null, myProfile: null, myTitle: null, photoFile: null, bioRawText: null,
    ranker: null, demandKeywords: [], cities: [], countries: [],
    boostStatus: 'off', isLive: false, receivedPhotoUrls: new Map(),
    conversations: new Map(), activeConversationId: null,
  },
};

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  renderLog(line);
  console.log(line);
}

async function init() {
  state.blockedPeers = new Set((await blocklist.listBlockedPeers()).map((b) => b.peerId));
  state.webgpuAvailable = await llm.detectWebGpuSupport().catch(() => false);
  renderShell(state.enabledModes, toggleMode);
  renderGlobalSettings({ onResetLocalData: handleResetLocalData });
}

// =====================================================================
// Bascule de modes (cumulables)
// =====================================================================

async function toggleMode(mode) {
  state.enabledModes[mode] = !state.enabledModes[mode];
  setModeVisibility(mode, state.enabledModes[mode]);
  if (!state.enabledModes[mode]) return;

  if (mode === 'jobCandidate') {
    if (!state.jobCandidate.identity) state.jobCandidate.identity = await identityStore.loadOrCreateIdentity('job_candidate');
    renderJobCandidateUi();
  } else if (mode === 'jobRecruiter') {
    if (!state.jobRecruiter.identity) state.jobRecruiter.identity = await identityStore.loadOrCreateIdentity('job_recruiter');
    renderRecruiterUi();
  } else if (mode === 'dating') {
    if (!state.dating.identity) state.dating.identity = await identityStore.loadOrCreateIdentity('dating');
    renderDatingUi();
  }
  log(`Mode ${mode} activé.`);
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
      broadcastJobCandidateIfLive(peerId);
      broadcastDatingIfLive(peerId);
    });
    state.trystero.onPeerLeave((peerId) => {
      log(`Pair déconnecté : ${peerId.slice(0, 8)}…`);
      for (const room of state.jobRecruiter.rooms.values()) room.ranker.removePeer(peerId);
      state.dating.ranker?.removePeer(peerId);
      refreshRecruiterUi();
      refreshDatingMatches();
    });
  } catch (e) {
    log(`Réseau P2P indisponible (${e.message}).`);
  }
}

// =====================================================================
// Identité — helpers génériques par mode
// =====================================================================

function identityCallbacks(modeKey, namespace, domain) {
  return {
    onSaveName: async (name) => {
      state[modeKey].identity = await identityStore.setDisplayName(namespace, name);
      log(`[${modeKey}] Nom mis à jour : ${state[modeKey].identity.displayName || '(vide)'}.`);
      rerender(modeKey);
      if (modeKey === 'jobCandidate') broadcastJobCandidateIfLive();
      if (modeKey === 'dating') broadcastDatingIfLive();
    },
    onRestoreId: async (id) => {
      try {
        state[modeKey].identity = await identityStore.restoreIdentity(namespace, id);
        log(`[${modeKey}] Identité restaurée : id ${state[modeKey].identity.id}.`);
        rerender(modeKey);
        if (modeKey === 'jobCandidate') broadcastJobCandidateIfLive();
        if (modeKey === 'dating') broadcastDatingIfLive();
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
      if (live && modeKey === 'jobCandidate') broadcastJobCandidateIfLive();
      if (live && modeKey === 'dating') broadcastDatingIfLive();
    },
  };
}

function rerender(modeKey) {
  if (modeKey === 'jobCandidate') renderJobCandidateUi();
  else if (modeKey === 'jobRecruiter') renderRecruiterUi();
  else if (modeKey === 'dating') renderDatingUi();
}

// =====================================================================
// Mode candidat (emploi)
// =====================================================================

function renderJobCandidateUi() {
  const s = state.jobCandidate;
  renderJobCandidatePanel({
    identity: s.identity,
    isLive: s.isLive,
    ...identityCallbacks('jobCandidate', 'job_candidate', Domain.JOB),
    onFileSelected: analyzeCv,
    onStartLive: startJobCandidateLive,
    onResetSearch: resetJobCandidateSearch,
  });
  if (s.localProfile) {
    renderCvAnalysisSection('jc-cv-analysis', s.localProfile, {
      boostStatus: s.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: boostJobCandidateKeywords,
    });
  }
  renderConversations('jobCandidate', 'jc-tabs', 'jc-conversation');
}

async function analyzeCv(file) {
  const s = state.jobCandidate;
  const documentId = `cv_${Date.now()}`;
  log('Analyse locale du CV (CPU, mots-clés uniquement)...');

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
  renderCvAnalysisSection('jc-cv-analysis', s.localProfile, {
    boostStatus: s.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: boostJobCandidateKeywords,
  });
}

async function boostJobCandidateKeywords() {
  const s = state.jobCandidate;
  if (!s.localProfile || !s.cvRawText) return;
  await runBoost(s, () => broadcastJobCandidateIfLive());
  renderCvAnalysisSection('jc-cv-analysis', s.localProfile, {
    boostStatus: s.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: boostJobCandidateKeywords,
  });
}

/** Boost générique réutilisé par candidat emploi et rencontre. */
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

async function startJobCandidateLive(kwRaw, cityRaw, countryRaw) {
  const s = state.jobCandidate;
  if (!s.localProfile || !s.cvFile) { log('Déposez et laissez analyser votre CV avant de lancer la recherche.'); return; }
  const keywords = parseCommaList(kwRaw);
  if (keywords.length === 0) { log('Au moins un mot-clé de recherche est requis.'); return; }
  const cities = parseCommaList(cityRaw);
  if (cities.length === 0) { log('Au moins une ville est requise.'); return; }
  s.searchKeywords = keywords;
  s.cities = cities;
  s.countries = parseCommaList(countryRaw);

  await ensureNetwork();
  s.isLive = true;
  broadcastJobCandidateIfLive();
  log(`[candidat] En direct : "${s.searchKeywords.join(', ')}" · ${s.cities.join(', ')} — CV diffusé.`);
  renderJobCandidateUi();
}

function broadcastJobCandidateIfLive(targetPeerId) {
  const s = state.jobCandidate;
  if (!s.isLive || !s.localProfile || s.searchKeywords.length === 0) return;
  const msg = createCandidateBroadcast({
    domain: Domain.JOB,
    senderId: s.identity.id, displayName: s.identity.displayName,
    searchKeywords: s.searchKeywords, skills: s.localProfile.keywords,
    cities: s.cities, countries: s.countries,
    yearsOfExperience: s.localProfile.yearsOfExperience,
    yearsOfExperienceEstimated: s.localProfile.yearsOfExperienceEstimated,
    cvFileName: s.cvFile?.name ?? null,
  });
  state.trystero?.send(msg, targetPeerId);
  if (s.cvFile) state.trystero?.sendFile(s.cvFile, { name: s.cvFile.name, mimeType: s.cvFile.type, kind: 'cv' }, targetPeerId);
}

async function resetJobCandidateSearch() {
  const s = state.jobCandidate;
  if (s.isLive) {
    state.trystero?.send(createIdentityRetired({ domain: Domain.JOB, retiredId: s.identity.id }));
    log('[candidat] Recherche arrêtée.');
  }
  s.localProfile = null; s.cvFile = null; s.cvRawText = null;
  s.searchKeywords = []; s.cities = []; s.countries = []; s.boostStatus = 'off'; s.isLive = false;
  renderJobCandidateUi();
}

// =====================================================================
// Mode annonceur (emploi)
// =====================================================================

function renderRecruiterUi() {
  const s = state.jobRecruiter;
  const rooms = Array.from(s.rooms.values()).map((r) => ({
    id: r.id, title: r.title, text: r.text, unread: r.unread || 0,
    candidates: Array.from(r.ranker.scores.values()).sort((a, b) => b.total - a.total),
  }));
  if (!s.activeRoomId && rooms.length > 0) s.activeRoomId = rooms[0].id;
  renderJobRecruiterPanel({
    identity: s.identity, rooms, activeRoomId: s.activeRoomId,
    ...identityCallbacks('jobRecruiter', 'job_recruiter', Domain.JOB),
    onCreateRoom: createRoom, onSelectRoom: selectRoom, onOpenCandidate: onOpenCandidateDetail, onRemoveRoom: removeRoom,
  });
  reopenPendingCandidateDetail();
}

async function createRoom({ title, text, minYearsRequired, maxYearsRequired, country }) {
  const s = state.jobRecruiter;
  if (s.rooms.size >= MAX_POSTINGS_PER_RECRUITER) { log(`Limite atteinte : ${MAX_POSTINGS_PER_RECRUITER} salles maximum.`); return; }
  const roomLocalId = `room_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  log('Analyse locale de l\'annonce (CPU, mots-clés uniquement)...');
  const doc = await parseDocument({ text, kind: 'job', id: roomLocalId });
  const { facts } = extractFacts(doc);
  const jobProfile = buildJobProfile({ documentId: roomLocalId, facts, rawText: text, minYearsRequired, maxYearsRequired, country });

  const finalTitle = title || text.split('\n')[0].slice(0, 60) || 'Annonce sans titre';
  const ranker = new RoomRanker(jobProfile, finalTitle);
  ranker.onRankingChange(() => refreshRecruiterUi());

  s.rooms.set(roomLocalId, { id: roomLocalId, title: finalTitle, text, jobProfile, ranker, unread: 0 });
  s.activeRoomId = roomLocalId;
  const rangeNote = (minYearsRequired != null || maxYearsRequired != null) ? `, ancienneté ${minYearsRequired ?? '0'}-${maxYearsRequired ?? '∞'} an(s)` : '';
  log(`Salle publiée : « ${finalTitle} » (mots-clés : ${jobProfile.keywords.join(', ') || 'aucun'}${rangeNote}${jobProfile.country ? `, pays ${jobProfile.country}` : ''}).`);

  await ensureNetwork();
  refreshRecruiterUi();
}

function removeRoom(roomId) {
  state.jobRecruiter.rooms.delete(roomId);
  if (state.jobRecruiter.activeRoomId === roomId) {
    const remaining = Array.from(state.jobRecruiter.rooms.keys());
    state.jobRecruiter.activeRoomId = remaining[0] || null;
  }
  log('Salle d\'annonce retirée.');
  refreshRecruiterUi();
}

function selectRoom(roomId) {
  state.jobRecruiter.activeRoomId = roomId;
  state.jobRecruiter.openCandidateContext = null;
  const room = state.jobRecruiter.rooms.get(roomId);
  if (room) room.unread = 0;
  refreshRecruiterUi();
}

function refreshRecruiterUi() {
  if (!state.enabledModes.jobRecruiter) return;
  renderRecruiterUi();
}

function reopenPendingCandidateDetail() {
  const s = state.jobRecruiter;
  const ctx = s.openCandidateContext;
  if (ctx && ctx.roomId === s.activeRoomId) {
    const room = s.rooms.get(ctx.roomId);
    const entry = room && Array.from(room.ranker.scores.values()).find((sc) => sc.peerId === ctx.peerId);
    if (room && entry) onOpenCandidateDetail(entry, room, { skipContextUpdate: true });
  } else if (s.openChatPeerId) {
    renderRecruiterChatView();
  }
}

function onOpenCandidateDetail(entry, room, opts = {}) {
  const s = state.jobRecruiter;
  if (!opts.skipContextUpdate) { s.openCandidateContext = { roomId: room.id, peerId: entry.peerId }; s.openChatPeerId = null; }
  renderCandidateDetail(entry, {
    cvUrl: s.receivedCvUrls.get(entry.peerId) || null,
    onProposeContact: (note) => {
      const who = entry.displayName || entry.peerId.slice(0, 8) + '…';
      s.knownChatPeers.add(entry.peerId);
      if (note) {
        const msg = createMeetingProposal({ domain: Domain.JOB, toPeerId: entry.peerId, roomTitle: room.title, note, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
        log(`Proposition de rendez-vous envoyée à ${who}.`);
      } else {
        const msg = createChatRequest({ domain: Domain.JOB, toPeerId: entry.peerId, roomTitle: room.title, fromName: s.identity.displayName, fromId: s.identity.id });
        state.trystero?.send(msg, entry.peerId);
        log(`Proposition de chat envoyée à ${who}.`);
      }
    },
  });
}

// --- Chat recruteur : mounté dans #detail-zone via le composant générique renderConversationView ---
async function openRecruiterChatThread(peerId) {
  const s = state.jobRecruiter;
  s.openChatPeerId = peerId;
  s.openCandidateContext = null;
  await chatStore.saveThread({ peerId, createdAt: Date.now(), active: true });
  const history = await chatStore.listMessagesForPeer(peerId);
  s.openChatHistory = history.map((m) => ({ senderId: m.senderId, text: m.text, timestamp: m.timestamp }));
  renderRecruiterChatView();
}

function renderRecruiterChatView() {
  const s = state.jobRecruiter;
  const conv = { status: 'active', history: s.openChatHistory || [] };
  renderConversationView('detail-zone', conv, {
    onAccept: () => {}, onDecline: () => {},
    onSend: (_id, text) => sendRecruiterChatMessage(text),
  });
}

function sendRecruiterChatMessage(text) {
  const s = state.jobRecruiter;
  const peerId = s.openChatPeerId;
  if (!peerId) return;
  const msg = createChatMessage({ domain: Domain.JOB, toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  s.openChatHistory.push({ senderId: 'me', text: msg.text, timestamp: msg.timestamp });
  renderRecruiterChatView();
}

function appendRecruiterChatMessage(peerId, message) {
  const s = state.jobRecruiter;
  if (s.openChatPeerId !== peerId) return; // conversation pas actuellement ouverte
  s.openChatHistory.push(message);
  renderRecruiterChatView();
}

// =====================================================================
// Mode Rencontre
// =====================================================================

function renderDatingUi() {
  const s = state.dating;
  renderDatingPanel({
    identity: s.identity, isLive: s.isLive,
    ...identityCallbacks('dating', 'dating', Domain.DATING),
    onPhotoSelected: (file) => { s.photoFile = file; log(`Photo sélectionnée : ${file.name}.`); },
    onStartLive: startDatingLive,
    onResetSearch: resetDatingSearch,
  });
  if (s.myProfile) {
    renderCvAnalysisSection('dt-analysis', s.myProfile, {
      boostStatus: s.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: boostDatingKeywords,
    });
  }
  refreshDatingMatches();
  renderConversations('dating', 'dt-tabs', 'dt-conversation');
}

async function startDatingLive({ title, demand, city, country, bio }) {
  const s = state.dating;
  const cities = parseCommaList(city);
  if (cities.length === 0) { log('Une ville est requise pour Rencontre.'); return; }
  const demandKeywords = parseCommaList(demand);
  if (demandKeywords.length === 0) { log('Au moins un mot-clé de demande est requis.'); return; }
  if (!bio || !bio.trim()) { log('Décrivez-vous un minimum avant de lancer.'); return; }

  const documentId = `dating_${Date.now()}`;
  const doc = await parseDocument({ text: bio, kind: 'cv', id: documentId });
  const { facts } = extractFacts(doc);
  const countryList = parseCommaList(country);

  // "Mon profil" = ma propre salle : les autres me trouvent via mes mots-clés (même mécanique qu'une salle d'annonce).
  s.myProfile = buildJobProfile({ documentId, facts, rawText: bio, country: countryList[0] || null });
  s.myTitle = title?.trim() || 'Profil sans titre';
  s.bioRawText = bio;
  s.cities = cities;
  s.countries = countryList;
  s.demandKeywords = demandKeywords;
  s.boostStatus = 'off';

  s.ranker = new RoomRanker(s.myProfile, s.myTitle);
  s.ranker.onRankingChange(() => refreshDatingMatches());

  await ensureNetwork();
  s.isLive = true;
  broadcastDatingIfLive();
  log(`[rencontre] En direct : « ${s.myTitle} » · ${s.cities.join(', ')} — profil + photo diffusés.`);
  renderDatingUi();
}

function broadcastDatingIfLive(targetPeerId) {
  const s = state.dating;
  if (!s.isLive || !s.myProfile) return;
  const msg = createCandidateBroadcast({
    domain: Domain.DATING,
    senderId: s.identity.id, displayName: s.identity.displayName || s.myTitle,
    searchKeywords: s.demandKeywords, skills: s.myProfile.keywords,
    cities: s.cities, countries: s.countries,
    cvFileName: s.photoFile?.name ?? null,
  });
  state.trystero?.send(msg, targetPeerId);
  if (s.photoFile) state.trystero?.sendFile(s.photoFile, { name: s.photoFile.name, mimeType: s.photoFile.type, kind: 'photo' }, targetPeerId);
}

async function boostDatingKeywords() {
  const s = state.dating;
  if (!s.myProfile || !s.bioRawText) return;
  await runBoost(s, () => broadcastDatingIfLive());
  renderCvAnalysisSection('dt-analysis', s.myProfile, {
    boostStatus: s.boostStatus, webgpuAvailable: state.webgpuAvailable, onBoost: boostDatingKeywords,
  });
}

async function resetDatingSearch() {
  const s = state.dating;
  if (s.isLive) {
    state.trystero?.send(createIdentityRetired({ domain: Domain.DATING, retiredId: s.identity.id }));
    log('[rencontre] Recherche arrêtée.');
  }
  s.myProfile = null; s.myTitle = null; s.photoFile = null; s.bioRawText = null;
  s.ranker = null; s.demandKeywords = []; s.cities = []; s.countries = []; s.boostStatus = 'off'; s.isLive = false;
  renderDatingUi();
}

function refreshDatingMatches() {
  if (!state.enabledModes.dating) return;
  if (!state.dating.ranker) { renderDatingMatches([], { onOpen: () => {} }); return; }
  const matches = Array.from(state.dating.ranker.scores.values()).map((sc) => ({
    ...sc, photoUrl: state.dating.receivedPhotoUrls.get(sc.peerId) || null,
  })).sort((a, b) => b.total - a.total);
  renderDatingMatches(matches, { onOpen: onOpenDatingMatch });
}

function onOpenDatingMatch(entry) {
  renderDatingMatchDetail(entry, {
    photoUrl: state.dating.receivedPhotoUrls.get(entry.peerId) || null,
    onProposeContact: (note) => {
      const who = entry.displayName || entry.peerId.slice(0, 8) + '…';
      if (note) {
        const msg = createMeetingProposal({ domain: Domain.DATING, toPeerId: entry.peerId, note, fromName: state.dating.identity.displayName, fromId: state.dating.identity.id });
        state.trystero?.send(msg, entry.peerId);
      } else {
        const msg = createChatRequest({ domain: Domain.DATING, toPeerId: entry.peerId, fromName: state.dating.identity.displayName, fromId: state.dating.identity.id });
        state.trystero?.send(msg, entry.peerId);
      }
      state.dating.conversations.set(entry.peerId, { id: entry.peerId, peerId: entry.peerId, displayName: entry.displayName, status: 'pending', direction: 'outgoing', history: [], unread: 0 });
      log(`Proposition envoyée à ${who}.`);
      renderConversations('dating', 'dt-tabs', 'dt-conversation');
    },
  });
}

// =====================================================================
// Messagerie à onglets — générique candidat emploi + rencontre
// =====================================================================

function renderConversations(modeKey, tabsContainerId, viewContainerId) {
  if (!state.enabledModes[modeKey]) return;
  const s = state[modeKey];
  const list = Array.from(s.conversations.values());
  renderConversationTabs(tabsContainerId, list, s.activeConversationId, (id) => selectConversation(modeKey, id, tabsContainerId, viewContainerId));
  const active = s.conversations.get(s.activeConversationId) || null;
  renderConversationView(viewContainerId, active, {
    onAccept: (id) => acceptConversation(modeKey, id, tabsContainerId, viewContainerId),
    onDecline: (id) => declineConversation(modeKey, id, tabsContainerId, viewContainerId),
    onSend: (id, text) => sendConversationMessage(modeKey, id, text, viewContainerId),
  });
}

function selectConversation(modeKey, id, tabsContainerId, viewContainerId) {
  const s = state[modeKey];
  s.activeConversationId = id;
  const conv = s.conversations.get(id);
  if (conv) conv.unread = 0;
  renderConversations(modeKey, tabsContainerId, viewContainerId);
}

async function acceptConversation(modeKey, peerId, tabsContainerId, viewContainerId) {
  const s = state[modeKey];
  const conv = s.conversations.get(peerId);
  if (!conv) return;
  const domain = modeKey === 'dating' ? Domain.DATING : Domain.JOB;
  state.trystero?.send(createChatResponse({ domain, toPeerId: peerId, requestId: conv.requestId, accepted: true }), peerId);
  conv.status = 'active';
  conv.unread = 0;
  await chatStore.saveThread({ peerId, createdAt: Date.now(), active: true });
  conv.history = (await chatStore.listMessagesForPeer(peerId)).map((m) => ({ senderId: m.senderId, text: m.text, timestamp: m.timestamp }));
  s.activeConversationId = peerId;
  renderConversations(modeKey, tabsContainerId, viewContainerId);
}

function declineConversation(modeKey, peerId, tabsContainerId, viewContainerId) {
  const s = state[modeKey];
  const conv = s.conversations.get(peerId);
  if (!conv) return;
  const domain = modeKey === 'dating' ? Domain.DATING : Domain.JOB;
  state.trystero?.send(createChatResponse({ domain, toPeerId: peerId, requestId: conv.requestId, accepted: false }), peerId);
  s.conversations.delete(peerId);
  if (s.activeConversationId === peerId) s.activeConversationId = null;
  renderConversations(modeKey, tabsContainerId, viewContainerId);
}

function sendConversationMessage(modeKey, peerId, text, viewContainerId) {
  const s = state[modeKey];
  const conv = s.conversations.get(peerId);
  if (!conv) return;
  const domain = modeKey === 'dating' ? Domain.DATING : Domain.JOB;
  const msg = createChatMessage({ domain, toPeerId: peerId, text });
  state.trystero?.send(msg, peerId);
  chatStore.saveMessage({ id: msg.id, peerId, senderId: 'me', timestamp: msg.timestamp, text: msg.text });
  conv.history.push({ senderId: 'me', text: msg.text, timestamp: msg.timestamp });
  renderConversationView(viewContainerId, conv, {
    onAccept: () => {}, onDecline: () => {},
    onSend: (id, t) => sendConversationMessage(modeKey, id, t, viewContainerId),
  });
}

function addIncomingProposal(modeKey, message, peerId, kind, tabsContainerId, viewContainerId) {
  const s = state[modeKey];
  const conv = {
    id: peerId, peerId, requestId: message.id,
    displayName: message.fromName, status: 'pending', direction: 'incoming',
    kind, note: message.note || null, roomTitle: message.roomTitle || null,
    unread: 1, history: [],
  };
  s.conversations.set(peerId, conv);
  if (!s.activeConversationId) s.activeConversationId = peerId;
  renderConversations(modeKey, tabsContainerId, viewContainerId);
}

// =====================================================================
// Réception réseau
// =====================================================================

function handleIncomingMessage(message, peerId) {
  if (state.blockedPeers.has(peerId)) return;
  const domain = message.domain || Domain.JOB;

  switch (message.type) {
    case MessageType.CANDIDATE_BROADCAST: {
      const validation = validateCandidateBroadcast({ ...message, peerId });
      if (!validation.ok) { console.warn('[main] diffusion rejetée', peerId, validation.errors); break; }
      if (domain === Domain.DATING) {
        if (state.dating.ranker) state.dating.ranker.ingestBroadcast(peerId, validation.value);
        refreshDatingMatches();
      } else if (state.enabledModes.jobRecruiter) {
        for (const room of state.jobRecruiter.rooms.values()) room.ranker.ingestBroadcast(peerId, validation.value);
        refreshRecruiterUi();
      }
      break;
    }
    case MessageType.IDENTITY_RETIRED:
      if (domain === Domain.DATING) { state.dating.ranker?.retireIdentity(message.retiredId); refreshDatingMatches(); }
      else { for (const room of state.jobRecruiter.rooms.values()) room.ranker.retireIdentity(message.retiredId); refreshRecruiterUi(); }
      break;
    case MessageType.CHAT_REQUEST:
    case MessageType.MEETING_PROPOSAL: {
      const kind = message.type === MessageType.MEETING_PROPOSAL ? 'meeting' : 'chat';
      if (domain === Domain.DATING && state.enabledModes.dating) {
        addIncomingProposal('dating', message, peerId, kind, 'dt-tabs', 'dt-conversation');
      } else if (domain === Domain.JOB && state.enabledModes.jobCandidate) {
        addIncomingProposal('jobCandidate', message, peerId, kind, 'jc-tabs', 'jc-conversation');
      }
      break;
    }
    case MessageType.CHAT_RESPONSE: {
      if (domain === Domain.DATING && state.dating.conversations.has(peerId)) {
        const conv = state.dating.conversations.get(peerId);
        if (message.accepted) { conv.status = 'active'; chatStore.saveThread({ peerId, createdAt: Date.now(), active: true }); }
        else state.dating.conversations.delete(peerId);
        renderConversations('dating', 'dt-tabs', 'dt-conversation');
      } else if (domain === Domain.JOB && state.jobRecruiter.knownChatPeers.has(peerId)) {
        if (message.accepted) openRecruiterChatThread(peerId);
        else log(`Proposition refusée par ${peerId.slice(0, 8)}…`);
      }
      break;
    }
    case MessageType.CHAT_MESSAGE: {
      chatStore.saveMessage({ id: message.id, peerId, senderId: peerId, timestamp: message.timestamp, text: message.text });
      if (domain === Domain.DATING && state.dating.conversations.has(peerId)) {
        const conv = state.dating.conversations.get(peerId);
        conv.history.push({ senderId: peerId, text: message.text, timestamp: message.timestamp });
        if (state.dating.activeConversationId !== peerId) conv.unread = (conv.unread || 0) + 1;
        renderConversations('dating', 'dt-tabs', 'dt-conversation');
      } else if (domain === Domain.JOB && state.jobCandidate.conversations.has(peerId)) {
        const conv = state.jobCandidate.conversations.get(peerId);
        conv.history.push({ senderId: peerId, text: message.text, timestamp: message.timestamp });
        if (state.jobCandidate.activeConversationId !== peerId) conv.unread = (conv.unread || 0) + 1;
        renderConversations('jobCandidate', 'jc-tabs', 'jc-conversation');
      } else if (domain === Domain.JOB && state.jobRecruiter.knownChatPeers.has(peerId)) {
        appendRecruiterChatMessage(peerId, { senderId: peerId, text: message.text, timestamp: message.timestamp });
      }
      break;
    }
    default: break;
  }
}

function handleIncomingFile(blob, meta, peerId) {
  if (state.blockedPeers.has(peerId)) return;
  const url = URL.createObjectURL(blob);
  if (meta?.kind === 'photo') {
    const previous = state.dating.receivedPhotoUrls.get(peerId);
    if (previous) URL.revokeObjectURL(previous);
    state.dating.receivedPhotoUrls.set(peerId, url);
    log(`Photo reçue de ${peerId.slice(0, 8)}…`);
    refreshDatingMatches();
  } else {
    const previous = state.jobRecruiter.receivedCvUrls.get(peerId);
    if (previous) URL.revokeObjectURL(previous);
    state.jobRecruiter.receivedCvUrls.set(peerId, url);
    log(`CV reçu de ${peerId.slice(0, 8)}… (${meta?.name || 'fichier'}).`);
    if (state.jobRecruiter.openCandidateContext?.peerId === peerId) refreshRecruiterUi();
  }
}

// =====================================================================
// Confidentialité
// =====================================================================

async function handleResetLocalData() {
  if (state.jobCandidate.isLive) state.trystero?.send(createIdentityRetired({ domain: Domain.JOB, retiredId: state.jobCandidate.identity?.id }));
  if (state.dating.isLive) state.trystero?.send(createIdentityRetired({ domain: Domain.DATING, retiredId: state.dating.identity?.id }));
  state.trystero?.leave();
  await wipeAllLocalData();
  identityStore.clearAllIdentities();
  log('Toutes les données locales et identités ont été supprimées.');
  window.location.reload();
}

init();
