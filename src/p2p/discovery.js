// src/p2p/discovery.js
//
// Flux simplifié : le candidat diffuse (broadcast) un résumé de mots-clés ;
// le recruteur, pour CHAQUE salle d'annonce qu'il gère, compare localement
// ces mots-clés à ceux de son annonce et maintient un classement (§34-36).
// L'annonce elle-même ne quitte jamais l'appareil du recruteur — seule la
// comparaison a lieu, en local, quand une diffusion arrive (§30, §33).

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
 * d'annonce, AVANT toute analyse (§ nouveau : éviter de surcharger le
 * recruteur avec des candidats hors sujet). Comparaison normalisée
 * (accents/casse) + tolérance de sous-chaîne dans les deux sens pour capter
 * les variantes ("data" <-> "data engineer").
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
    id: broadcast.peerId,
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
    /** @type {Map<string, any>} peerId -> dernière diffusion brute reçue */
    this.broadcasts = new Map();
    /** @type {Map<string, any>} peerId -> MatchScore */
    this.scores = new Map();
    /** @type {Set<(ranking: any[]) => void>} */
    this.listeners = new Set();
  }

  onRankingChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const ranking = Array.from(this.scores.entries())
      .map(([peerId, score]) => ({ ...score, peerId }))
      .sort((a, b) => b.total - a.total);
    this.listeners.forEach((fn) => fn(ranking));
  }

  /**
   * Traite une diffusion candidat reçue (§61 : dédupliquée par horodatage).
   * Le mot-clé déclaré par le candidat doit correspondre à cette salle,
   * sinon la diffusion est ignorée AVANT toute analyse (pas de filtre CPU,
   * pas de scoring) — c'est le premier tri, le moins coûteux.
   * @param {string} peerId
   * @param {import('../core/validation/schema.js').CandidateBroadcast} broadcast
   */
  ingestBroadcast(peerId, broadcast) {
    const previous = this.broadcasts.get(peerId);
    if (previous && previous.timestamp === broadcast.timestamp) return; // déduplication (§61)

    if (!matchesKeywordGate(broadcast.searchKeyword, this.keywordSet)) {
      const hadEntry = this.scores.delete(peerId);
      this.broadcasts.delete(peerId);
      if (hadEntry) this._emit(); // le candidat était visible et a changé de mot-clé : on retire la ligne
      return; // mot-clé hors sujet pour cette salle : on ne va pas plus loin
    }

    this.broadcasts.set(peerId, broadcast);
    const candidate = candidateBroadcastToComparable(broadcast);
    if (!passesCpuFilter(candidate, this.jobProfile)) {
      this.scores.delete(peerId);
      this._emit();
      return;
    }
    const score = computeMatchScore(candidate, this.jobProfile);
    this.scores.set(peerId, {
      ...score,
      displayName: broadcast.displayName || null,
      cvFileName: broadcast.cvFileName || null,
    });
    this._emit();
  }

  removePeer(peerId) {
    const had = this.scores.delete(peerId);
    this.broadcasts.delete(peerId);
    if (had) this._emit();
  }
}
