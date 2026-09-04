import test from 'node:test';
import assert from 'node:assert/strict';

import { MatchingRanker, peerProfileToComparable, peerPostingToComparable } from '../src/p2p/discovery.js';
import { buildCandidateProfile, buildJobProfile } from '../src/core/extraction/buildProfile.js';

function candidateWithSkill(skill) {
  return buildCandidateProfile({ documentId: 'me', facts: [{ id: '1', field: 'skill', value: skill, sourceDocumentId: 'me' }] });
}

test('côté candidat : un recruteur avec plusieurs annonces produit une ligne par annonce (§1, §61)', () => {
  const candidate = candidateWithSkill('python');
  const ranker = new MatchingRanker(candidate, 'candidate');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestPeerProfile('recruiterA', {
    peerId: 'recruiterA',
    role: 'recruiter',
    capabilities: {
      displayName: 'Acme Corp',
      postings: [
        { id: 'job1', title: 'Data Engineer', skills: ['python'], visibilityThreshold: 0 },
        { id: 'job2', title: 'Photographe', skills: ['photographie'], visibilityThreshold: 0 },
      ],
    },
  });

  const last = events[events.length - 1];
  // job1 matche (skill commun) ; job2 est filtré par passesCpuFilter (aucun recoupement).
  assert.equal(last.length, 1);
  assert.equal(last[0].postingId, 'job1');
  assert.equal(last[0].displayName, 'Acme Corp');
});

test('côté candidat : une annonce sous le seuil de visibilité du recruteur est masquée', () => {
  const candidate = candidateWithSkill('sql'); // une seule compétence commune -> score modeste
  const ranker = new MatchingRanker(candidate, 'candidate');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestPeerProfile('recruiterB', {
    peerId: 'recruiterB',
    role: 'recruiter',
    capabilities: {
      postings: [{ id: 'jobX', skills: ['sql', 'kubernetes', 'terraform'], visibilityThreshold: 95 }],
    },
  });

  assert.equal(events[events.length - 1].length, 0, 'le score ne doit pas atteindre 95 avec une seule compétence sur trois');
});

test('mise à jour de seuil en direct recalcule la visibilité sans re-scoring réseau', () => {
  const candidate = candidateWithSkill('python');
  const ranker = new MatchingRanker(candidate, 'candidate');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestPeerProfile('recruiterC', {
    peerId: 'recruiterC',
    role: 'recruiter',
    capabilities: { postings: [{ id: 'jobY', skills: ['python'], visibilityThreshold: 0 }] },
  });
  assert.equal(events[events.length - 1].length, 1, 'visible au seuil 0');

  ranker.applyThresholdUpdate('recruiterC', 'jobY', 100);
  assert.equal(events[events.length - 1].length, 0, 'masquée après relèvement du seuil à 100');

  ranker.applyThresholdUpdate('recruiterC', 'jobY', 0);
  assert.equal(events[events.length - 1].length, 1, 'revient visible après baisse du seuil');
});

test('côté recruteur : le tableau de bord montre tous les candidats, marqués visible/non-visible selon le curseur', () => {
  const job = buildJobProfile({ documentId: 'job1', facts: [{ id: '1', field: 'skill', value: 'python', sourceDocumentId: 'job1' }] });
  const ranker = new MatchingRanker(job, 'recruiter');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestPeerProfile('candidateA', { peerId: 'candidateA', role: 'candidate', capabilities: { skills: ['python'] }, updatedAt: 1 });

  let last = events[events.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].visible, true, 'visible par défaut (seuil 0)');

  ranker.setOwnThreshold(100);
  last = events[events.length - 1];
  assert.equal(last[0].visible, false, 'devient non-visible en direct quand le curseur monte, sans disparaître du tableau de bord recruteur');
});

test('une annonce retirée du profil publié disparaît du classement candidat', () => {
  const candidate = candidateWithSkill('python');
  const ranker = new MatchingRanker(candidate, 'candidate');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestPeerProfile('recruiterD', {
    peerId: 'recruiterD', role: 'recruiter',
    capabilities: { postings: [{ id: 'jobZ', skills: ['python'], visibilityThreshold: 0 }] },
  });
  assert.equal(events[events.length - 1].length, 1);

  ranker.ingestPeerProfile('recruiterD', { peerId: 'recruiterD', role: 'recruiter', capabilities: { postings: [] } });
  assert.equal(events[events.length - 1].length, 0);
});

test('peerPostingToComparable ne fabrique jamais de texte intégral', () => {
  const comparable = peerPostingToComparable({ id: 'j1', skills: ['sql'] });
  assert.equal(comparable.id, 'j1');
  assert.ok(!('description' in comparable));
});

test('peerProfileToComparable (candidat) ne fabrique jamais de texte intégral', () => {
  const comparable = peerProfileToComparable({ peerId: 'p1', role: 'candidate', capabilities: { skills: ['sql'] } });
  assert.equal(comparable.id, 'p1');
  assert.ok(!('fullText' in comparable));
});
