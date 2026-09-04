// src/p2p/discovery.js
//
// Orchestration haut niveau : reçoit les profils découverts (via Nostr et/ou
// les peer_hello Trystero), les fait passer au filtre CPU, puis déclenche un
// scoring incrémental sans jamais solliciter WebLLM pour chaque événement
// réseau brut (§33).

import { passesCpuFilter } from '../core/matching/matchEngine.js';
import { computeMatchScore } from '../core/scoring/scoreEngine.js';

/**
 * Petit gestionnaire de classement dynamique (§36). Conserve les profils
 * pairs connus et met à jour un classement de scores à chaque nouveauté,
 * en amortissant les recalculs à un pair à la fois (pas de recomputation
 * globale coûteuse à chaque event réseau).
 */
export class MatchingRanker {
  /**
   * @param {import('../core/extraction/buildProfile.js').CandidateProfile | import('../core/extraction/buildProfile.js').JobProfile} localProfile
   * @param {'candidate'|'recruiter'} role
   */
  constructor(localProfile, role) {
    this.localProfile = localProfile;
    this.role = role;
    /** @type {Map<string, any>} peerId -> profil pair minimal converti */
    this.peerProfiles = new Map();
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
    const ranking = Array.from(this.scores.values()).sort((a, b) => b.total - a.total);
    this.listeners.forEach((fn) => fn(ranking));
  }

  /**
   * Traite un nouveau profil pair découvert (§36). `toComparableProfile`
   * convertit le PeerProfile réseau minimal en structure comparable au
   * scoring (approximative tant qu'un scoring complet n'a pas été demandé).
   * @param {string} peerId
   * @param {any} peerProfile
   * @param {(peerProfile: any) => any} toComparableProfile
   */
  ingestPeerProfile(peerId, peerProfile, toComparableProfile) {
    if (this.peerProfiles.has(peerId)) return; // déduplication (§61)
    this.peerProfiles.set(peerId, peerProfile);

    const comparable = toComparableProfile(peerProfile);
    // Rôles opposés seulement : un candidat matche des annonces, pas d'autres candidats.
    const expectedRole = this.role === 'candidate' ? 'recruiter' : 'candidate';
    if (peerProfile.role !== expectedRole) return;

    const candidate = this.role === 'candidate' ? this.localProfile : comparable;
    const job = this.role === 'candidate' ? comparable : this.localProfile;

    if (!passesCpuFilter(candidate, job)) return; // filtre CPU avant tout scoring (§30-31)

    const score = computeMatchScore(candidate, job);
    this.scores.set(peerId, { ...score, peerId });
    this._emit();
  }

  removePeer(peerId) {
    this.peerProfiles.delete(peerId);
    if (this.scores.delete(peerId)) this._emit();
  }
}

/**
 * Convertit un PeerProfile réseau minimal en profil "comparable" pour le
 * scoring, en marquant explicitement les champs absents comme inconnus
 * plutôt que de les inventer (§27, §58).
 * @param {import('../core/validation/schema.js').PeerProfile} peerProfile
 */
export function peerProfileToComparable(peerProfile) {
  const caps = peerProfile.capabilities || {};
  const skills = (caps.skills || []).map((name) => ({ name, provenance: 'explicit', sourceDocumentId: peerProfile.peerId }));
  if (peerProfile.role === 'candidate') {
    return {
      id: peerProfile.peerId,
      skills,
      domains: caps.domains || [],
      languages: caps.languages || [],
      experiences: [],
      education: [],
      yearsOfExperience: null,
      seniority: caps.seniority || null,
      seniorityConfidence: caps.seniority ? 'explicit' : 'unknown',
      locations: caps.locations || [],
      preferences: null,
    };
  }
  return {
    id: peerProfile.peerId,
    requiredSkills: skills,
    preferredSkills: [],
    responsibilities: [],
    domains: caps.domains || [],
    languages: caps.languages || [],
    seniority: caps.seniority || null,
    seniorityConfidence: caps.seniority ? 'explicit' : 'unknown',
    locations: caps.locations || [],
    constraints: [],
  };
}
