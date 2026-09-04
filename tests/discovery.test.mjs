import test from 'node:test';
import assert from 'node:assert/strict';

import { MatchingRanker, peerProfileToComparable } from '../src/p2p/discovery.js';
import { buildCandidateProfile } from '../src/core/extraction/buildProfile.js';

test('MatchingRanker ignore les pairs de même rôle et déduplique (§36, §61)', () => {
  const candidate = buildCandidateProfile({
    documentId: 'me',
    facts: [{ id: '1', field: 'skill', value: 'python', sourceDocumentId: 'me' }],
  });
  const ranker = new MatchingRanker(candidate, 'candidate');

  const events = [];
  ranker.onRankingChange((r) => events.push(r.length));

  // Un autre candidat : doit être ignoré (mauvais rôle).
  ranker.ingestPeerProfile('peer1', { peerId: 'peer1', role: 'candidate', capabilities: { skills: ['python'] } }, peerProfileToComparable);
  assert.equal(ranker.scores.size, 0);

  // Un recruteur pertinent : doit produire un score.
  ranker.ingestPeerProfile('peer2', { peerId: 'peer2', role: 'recruiter', capabilities: { skills: ['python'] } }, peerProfileToComparable);
  assert.equal(ranker.scores.size, 1);

  // Même pair renvoyé deux fois -> pas de doublon.
  ranker.ingestPeerProfile('peer2', { peerId: 'peer2', role: 'recruiter', capabilities: { skills: ['python'] } }, peerProfileToComparable);
  assert.equal(ranker.scores.size, 1);
  assert.equal(events.length, 1); // un seul événement émis (le doublon ne réémet pas)
});

test('peerProfileToComparable ne fabrique jamais de texte intégral de document', () => {
  const comparable = peerProfileToComparable({ peerId: 'p1', role: 'candidate', capabilities: { skills: ['sql'] } });
  assert.equal(comparable.id, 'p1');
  assert.ok(!('fullText' in comparable));
});
