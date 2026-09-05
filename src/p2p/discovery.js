// src/p2p/discovery.js
//
// Flux simplifié : le candidat diffuse (broadcast) un résumé de mots-clés ;
// le recruteur, pour CHAQUE salle d'annonce qu'il gère, compare localement
// ces mots-clés à ceux de son annonce et maintient un classement (§34-36).
// L'annonce elle-même ne quitte jamais l'appareil du recruteur — seule la
// comparaison a lieu, en local, quand une diffusion arrive (§30, §33).
//
// Le classement est indexé par IDENTITÉ APPLICATIVE (`broadcast.senderId`,
// stable pour la durée de l'onglet du candidat — voir storage/identity.js),
// PAS par l'identifiant de transport Trystero (éphémère, change à chaque
// reconnexion). Sans ça, une simple coupure réseau ferait apparaître le
// même candidat comme un nouveau profil dupliqué.

import { passesCpuFilter } from '../core/matching/matchEngine.js';
import { computeMatchScore } from '../core/scoring/scoreEngine.js';
import { cleanToken, normalizeSkillList } from '../core/normalization/normalize.js';

/**
 * Construit l'ensemble des mots-clés d'une salle d'annonce : compétences et
 * domaines normalisés, plus chaque mot du titre pris individuellement (un
 * titre "Data Engineer" doit pouvoir être trouvé par le mot-clé "data" ou
 * "engineer" aussi bien que par "data engineer" entier).
 * @param {import('../core/extraction/buildProfile.js').JobProfile} jobProfile
 * @param {string} [title]
 */
function buildRoomKeywordSet(jobProfile, title) {
  const skillDomainWords = normalizeSkillList([
    ...(jobProfile.requiredSkills || []).map((s) => s.name),
    ...(jobProfile.domains || []),
  ]);
  const titleWords = (title || '').split(/\s+/).map(cleanToken).filter((w) => w.length > 1);
  return new Set([...skillDomainWords, ...titleWords]);
}

/**
 * Vérifie qu'un mot-clé déclaré par un candidat correspond à la salle
 * d'annonce, AVANT toute analyse (évite de surcharger le recruteur avec des
 * candidats hors sujet). Comparaison normalisée (accents/casse) +
 * tolérance de sous-chaîne dans les deux sens ("data" <-> "data engineer").
 * @param {string} candidateKeyword
 * @param {Set<string>} roomKeywordSet
 */
export function matchesKeywordGate(candidateKeyword, roomKeywordSet) {
  const ck = cleanToken(candidateKeyword);
  if (!ck) return false;
  for (const kw of roomKeywordSet) {
    if (kw === ck || kw.includes(ck) || ck.includes(kw)) return true;
  }
  return false;
}

/**
 * Convertit une diffusion candidat (mots-clés uniquement) en objet
 * comparable au scoring (forme CandidateProfile). Rien n'est inventé : les
 * champs absents restent explicitement vides/inconnus (§27, §58).
 * @param {import('../core/validation/schema.js').CandidateBroadcast} broadcast
 */
export function candidateBroadcastToComparable(broadcast) {
  const skills = (broadcast.skills || []).map((name) => ({ name, provenance: 'explicit', sourceDocumentId: 'broadcast' }));
  return {
    id: broadcast.senderId || broadcast.peerId,
    skills,
    domains: broadcast.domains || [],
    languages: broadcast.languages || [],
    experiences: [],
    education: [],
    yearsOfExperience: null,
    seniority: broadcast.seniority || null,
    seniorityConfidence: broadcast.seniority ? 'explicit' : 'unknown',
    locations: broadcast.locations || [],
    preferences: null,
  };
}

/**
 * Classement dynamique pour UNE salle d'annonce (§36, §61). Chaque salle du
 * recruteur possède sa propre instance : les candidats sont scorés
 * indépendamment pour chaque annonce.
 */
export class RoomRanker {
  /**
   * @param {import('../core/extraction/buildProfile.js').JobProfile} jobProfile
   * @param {string} [title] Titre de la salle, utilisé pour enrichir le filtre par mot-clé.
   */
  constructor(jobProfile, title) {
    this.jobProfile = jobProfile;
    this.keywordSet = buildRoomKeywordSet(jobProfile, title);
    /** @type {Map<string, any>} identityKey -> dernière diffusion brute reçue */
    this.broadcasts = new Map();
    /** @type {Map<string, any>} identityKey -> MatchScore (inclut le peerId de transport courant) */
    this.scores = new Map();
    /** @type {Map<string, Set<string>>} peerId de transport -> TOUTES les identityKey vues depuis ce pair (couvre une rotation d'ID en direct, §"tuer" un ID) */
    this.peerIdHistory = new Map();
    /** @type {Set<(ranking: any[]) => void>} */
    this.listeners = new Set();
  }

  onRankingChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const ranking = Array.from(this.scores.entries())
      .map(([identityKey, score]) => ({ ...score, identityKey }))
      .sort((a, b) => b.total - a.total);
    this.listeners.forEach((fn) => fn(ranking));
  }

  /**
   * Traite une diffusion candidat reçue (§61 : dédupliquée par horodatage).
   * Indexée par identité applicative (`broadcast.senderId`), pas par
   * l'identifiant de transport éphémère — une reconnexion du même candidat
   * met à jour SA ligne au lieu d'en créer une nouvelle.
   * @param {string} peerId identifiant de transport Trystero courant
   * @param {import('../core/validation/schema.js').CandidateBroadcast} broadcast
   */
  ingestBroadcast(peerId, broadcast) {
    const identityKey = broadcast.senderId || peerId;
    if (!this.peerIdHistory.has(peerId)) this.peerIdHistory.set(peerId, new Set());
    this.peerIdHistory.get(peerId).add(identityKey);

    const previous = this.broadcasts.get(identityKey);
    if (previous && previous.timestamp === broadcast.timestamp) return; // déduplication (§61)

    if (!matchesKeywordGate(broadcast.searchKeyword, this.keywordSet)) {
      const hadEntry = this.scores.delete(identityKey);
      this.broadcasts.delete(identityKey);
      if (hadEntry) this._emit(); // le candidat était visible et a changé de mot-clé : on retire la ligne
      return; // mot-clé hors sujet pour cette salle : on ne va pas plus loin
    }

    this.broadcasts.set(identityKey, broadcast);
    const candidate = candidateBroadcastToComparable(broadcast);
    if (!passesCpuFilter(candidate, this.jobProfile)) {
      this.scores.delete(identityKey);
      this._emit();
      return;
    }
    const score = computeMatchScore(candidate, this.jobProfile);
    this.scores.set(identityKey, {
      ...score,
      peerId, // identifiant de transport courant : utilisé pour router les messages (chat, rendez-vous)
      displayName: broadcast.displayName || null,
      cvFileName: broadcast.cvFileName || null,
    });
    this._emit();
  }

  /** Appelé à la déconnexion d'un pair (identifiant de transport). Nettoie
   * TOUTES les identités jamais vues depuis ce pair, pas seulement la
   * dernière — utile si l'identité a été régénérée en cours de session. */
  removePeer(peerId) {
    const keys = this.peerIdHistory.get(peerId) || new Set();
    this.peerIdHistory.delete(peerId);
    let changed = false;
    for (const identityKey of keys) {
      if (this.scores.delete(identityKey)) changed = true;
      this.broadcasts.delete(identityKey);
    }
    if (changed) this._emit();
  }

  /**
   * Retire immédiatement une identité précise, sans attendre une
   * déconnexion réseau (§ "tuer" un ID compromis — voir
   * p2p/protocol.js MessageType.IDENTITY_RETIRED). L'ancien ID redevient
   * un simple identifiant orphelin, sans ligne associée dans le classement.
   * @param {string} identityKey
   */
  retireIdentity(identityKey) {
    if (!identityKey) return;
    const had = this.scores.delete(identityKey);
    this.broadcasts.delete(identityKey);
    if (had) this._emit();
  }
}
