// src/p2p/discovery.js
//
// Orchestration haut niveau : reçoit les profils découverts (via Nostr et/ou
// les peer_hello Trystero), les fait passer au filtre CPU, puis déclenche un
// scoring incrémental sans jamais solliciter WebLLM pour chaque événement
// réseau brut (§33).
//
// Gère aussi la visibilité dynamique par seuil de score : un recruteur peut
// avoir plusieurs annonces actives (§1), chacune avec son propre curseur de
// score minimal. Le filtrage est appliqué CÔTÉ CANDIDAT (chaque appareil
// décide localement, à partir du seuil publié par le recruteur, s'il peut
// voir l'annonce) — cohérent avec l'architecture décentralisée : aucune
// autorité centrale ne "cache" quoi que ce soit, chaque client applique la
// règle sur les données publiques qu'il reçoit.

import { passesCpuFilter } from '../core/matching/matchEngine.js';
import { computeMatchScore } from '../core/scoring/scoreEngine.js';
import { DEFAULT_VISIBILITY_THRESHOLD } from '../config/matching.js';

/**
 * Convertit une "posting" (annonce) d'un profil réseau recruteur en objet
 * comparable au scoring (forme JobProfile).
 * @param {{ id: string, title?: string, skills?: string[], domains?: string[], seniority?: string, locations?: string[], languages?: string[] }} posting
 */
export function peerPostingToComparable(posting) {
  const skills = (posting.skills || []).map((name) => ({ name, provenance: 'explicit', sourceDocumentId: posting.id }));
  return {
    id: posting.id,
    requiredSkills: skills,
    preferredSkills: [],
    responsibilities: [],
    domains: posting.domains || [],
    languages: posting.languages || [],
    seniority: posting.seniority || null,
    seniorityConfidence: posting.seniority ? 'explicit' : 'unknown',
    locations: posting.locations || [],
    constraints: [],
  };
}

/**
 * Convertit un PeerProfile réseau minimal *candidat* en profil comparable
 * (CandidateProfile). Les champs absents sont explicitement UNKNOWN plutôt
 * qu'inventés (§27, §58).
 * @param {import('../core/validation/schema.js').PeerProfile} peerProfile
 */
export function peerProfileToComparable(peerProfile) {
  const caps = peerProfile.capabilities || {};
  const skills = (caps.skills || []).map((name) => ({ name, provenance: 'explicit', sourceDocumentId: peerProfile.peerId }));
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

/**
 * Classement dynamique (§36). Une instance gère soit :
 *  - un candidat unique face à N annonces découvertes chez N recruteurs
 *    (role: 'candidate') — chaque ligne = une annonce, filtrée par le seuil
 *    de visibilité que CE recruteur a publié pour CETTE annonce ;
 *  - une annonce unique d'un recruteur face à N candidats découverts
 *    (role: 'recruiter') — toutes les lignes sont montrées, mais marquées
 *    `visible` selon le curseur local du recruteur, pour un retour temps
 *    réel pendant qu'il ajuste le curseur.
 */
export class MatchingRanker {
  /**
   * @param {any} localProfile  CandidateProfile (role='candidate') ou JobProfile d'UNE annonce (role='recruiter')
   * @param {'candidate'|'recruiter'} role
   */
  constructor(localProfile, role) {
    this.localProfile = localProfile;
    this.role = role;
    /** @type {Map<string, any>} clé composite -> dernier profil pair brut associé */
    this.peerProfiles = new Map();
    /** @type {Map<string, any>} clé composite -> MatchScore */
    this.scores = new Map();
    /** @type {Map<string, number>} clé composite -> seuil de visibilité applicable (mode candidat) */
    this.thresholds = new Map();
    /** Seuil local réglé par le recruteur pour SA propre annonce (mode recruteur). */
    this.ownThreshold = DEFAULT_VISIBILITY_THRESHOLD;
    /** @type {Set<(ranking: any[]) => void>} */
    this.listeners = new Set();
  }

  onRankingChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    let ranking = Array.from(this.scores.entries()).map(([key, score]) => ({ ...score, _key: key }));

    if (this.role === 'candidate') {
      // Chaque ligne = une annonce d'un recruteur : visible seulement si mon
      // score calculé localement atteint le seuil publié pour CETTE annonce.
      ranking = ranking.filter((entry) => entry.total >= (this.thresholds.get(entry._key) ?? DEFAULT_VISIBILITY_THRESHOLD));
    } else {
      // Mode recruteur : on ne cache rien localement (c'est MON tableau de
      // bord), mais on marque ce qui serait visible aux yeux d'un candidat
      // au seuil actuel, pour un retour temps réel pendant qu'on bouge le curseur.
      ranking = ranking.map((entry) => ({ ...entry, visible: entry.total >= this.ownThreshold }));
    }

    ranking.sort((a, b) => b.total - a.total);
    this.listeners.forEach((fn) => fn(ranking));
  }

  /**
   * Traite un profil pair découvert (§36, §61 déduplication par clé composite).
   * @param {string} peerId
   * @param {import('../core/validation/schema.js').PeerProfile} peerProfile
   */
  ingestPeerProfile(peerId, peerProfile) {
    if (this.role === 'candidate') {
      if (peerProfile.role !== 'recruiter') return; // un candidat ne matche que des recruteurs
      const postings = peerProfile.capabilities?.postings || [];
      for (const posting of postings) {
        const key = `${peerId}::${posting.id}`;
        this.peerProfiles.set(key, { peerId, posting, displayName: peerProfile.capabilities?.displayName || null });
        this.thresholds.set(key, typeof posting.visibilityThreshold === 'number' ? posting.visibilityThreshold : DEFAULT_VISIBILITY_THRESHOLD);

        const job = peerPostingToComparable(posting);
        if (!passesCpuFilter(this.localProfile, job)) { this.scores.delete(key); continue; }
        const score = computeMatchScore(this.localProfile, job);
        this.scores.set(key, { ...score, peerId, postingId: posting.id, postingTitle: posting.title || null, displayName: peerProfile.capabilities?.displayName || null });
      }
      // Une annonce retirée par le recruteur (postings ne la contient plus) doit disparaître.
      for (const key of Array.from(this.peerProfiles.keys())) {
        if (key.startsWith(`${peerId}::`) && !postings.some((p) => `${peerId}::${p.id}` === key)) {
          this.peerProfiles.delete(key);
          this.scores.delete(key);
          this.thresholds.delete(key);
        }
      }
      this._emit();
      return;
    }

    // role === 'recruiter' : cette instance ne représente qu'UNE annonce.
    if (peerProfile.role !== 'candidate') return;
    const key = peerId;
    if (this.scores.has(key) && this.peerProfiles.get(key)?.updatedAt === peerProfile.updatedAt) return; // dédup (§61)
    this.peerProfiles.set(key, peerProfile);

    const candidate = peerProfileToComparable(peerProfile);
    if (!passesCpuFilter(candidate, this.localProfile)) { this.scores.delete(key); this._emit(); return; }
    const score = computeMatchScore(candidate, this.localProfile);
    this.scores.set(key, { ...score, peerId, displayName: peerProfile.capabilities?.displayName || null });
    this._emit();
  }

  /**
   * Applique une mise à jour de seuil reçue en direct d'un recruteur
   * (mode candidat) — recalcul instantané, sans réanalyse ni re-scoring.
   * @param {string} peerId
   * @param {string} postingId
   * @param {number} threshold
   */
  applyThresholdUpdate(peerId, postingId, threshold) {
    if (this.role !== 'candidate') return;
    const key = `${peerId}::${postingId}`;
    if (!this.scores.has(key)) return; // annonce inconnue : rien à mettre à jour
    this.thresholds.set(key, threshold);
    this._emit();
  }

  /** Règle mon propre curseur (mode recruteur) — appelé en temps réel pendant le drag. */
  setOwnThreshold(threshold) {
    if (this.role !== 'recruiter') return;
    this.ownThreshold = threshold;
    this._emit();
  }

  removePeer(peerId) {
    let changed = false;
    for (const key of Array.from(this.scores.keys())) {
      if (key === peerId || key.startsWith(`${peerId}::`)) {
        this.scores.delete(key);
        this.peerProfiles.delete(key);
        this.thresholds.delete(key);
        changed = true;
      }
    }
    if (changed) this._emit();
  }
}
