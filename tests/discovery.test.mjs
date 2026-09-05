import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomRanker, candidateBroadcastToComparable, matchesKeywordGate } from '../src/p2p/discovery.js';
import { buildJobProfile } from '../src/core/extraction/buildProfile.js';

function jobWithSkill(skill) {
  return buildJobProfile({ documentId: 'job1', facts: [{ id: '1', field: 'skill', value: skill, sourceDocumentId: 'job1' }] });
}

test('une diffusion dont le mot-clé ne correspond à rien dans la salle est ignorée avant toute analyse', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  // Compétences communes (python) MAIS mot-clé hors sujet : ne doit rien produire.
  ranker.ingestBroadcast('cand0', { peerId: 'cand0', searchKeyword: 'photographie', skills: ['python'], timestamp: 1 });
  assert.equal(events.length, 0, 'aucun événement ne doit être émis pour une diffusion filtrée par mot-clé');
});

test('un mot-clé qui correspond au titre de la salle passe le filtre', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand1', { peerId: 'cand1', searchKeyword: 'data', skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);
});

test('un mot-clé qui correspond à une compétence de la salle passe le filtre', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Poste sans rapport');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand2', { peerId: 'cand2', searchKeyword: 'python', skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);
});

test('changer de mot-clé vers un sujet hors annonce retire le candidat du classement', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeyword: 'python', skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);

  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeyword: 'photographie', skills: ['python'], timestamp: 2 });
  assert.equal(events[events.length - 1].length, 0);
});

test('matchesKeywordGate ignore casse et accents', () => {
  const set = new Set(['data', 'python']);
  assert.equal(matchesKeywordGate('Data', set), true);
  assert.equal(matchesKeywordGate('DATA', set), true);
  assert.equal(matchesKeywordGate('js', set), false);
});

test('RoomRanker score une diffusion candidat pertinente et la classe', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job);
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand1', { peerId: 'cand1', displayName: 'Jean', searchKeyword: 'python', skills: ['python'], cvFileName: 'cv.docx', timestamp: 1 });

  const last = events[events.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].displayName, 'Jean');
  assert.equal(last[0].cvFileName, 'cv.docx');
  assert.ok(last[0].total > 0);
});

test('RoomRanker filtre les diffusions sans aucun recoupement (§30-31)', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job);
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand2', { peerId: 'cand2', displayName: 'Ana', searchKeyword: 'python', skills: ['photographie'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 0);
});

test('RoomRanker déduplique une diffusion identique (même horodatage, §61)', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job);
  let emitCount = 0;
  ranker.onRankingChange(() => { emitCount += 1; });

  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeyword: 'python', skills: ['python'], timestamp: 42 });
  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeyword: 'python', skills: ['python'], timestamp: 42 });
  assert.equal(emitCount, 1, 'la seconde diffusion identique ne doit pas redéclencher un événement');
});

test('RoomRanker met à jour un candidat déjà connu si sa diffusion change (nouvel horodatage)', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job);
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand4', { peerId: 'cand4', searchKeyword: 'python', skills: [], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 0);

  ranker.ingestBroadcast('cand4', { peerId: 'cand4', searchKeyword: 'python', skills: ['python'], timestamp: 2 });
  assert.equal(events[events.length - 1].length, 1);
});

test('RoomRanker.removePeer retire un candidat du classement', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job);
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand5', { peerId: 'cand5', searchKeyword: 'python', skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);

  ranker.removePeer('cand5');
  assert.equal(events[events.length - 1].length, 0);
});

test('candidateBroadcastToComparable ne fabrique jamais de texte intégral', () => {
  const comparable = candidateBroadcastToComparable({ peerId: 'p1', skills: ['sql'] });
  assert.equal(comparable.id, 'p1');
  assert.ok(!('fullText' in comparable));
});

test("un candidat reconnecte (nouveau peerId de transport, meme senderId) met a jour sa ligne au lieu d'en creer une nouvelle", () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('tcp-abc', { peerId: 'tcp-abc', senderId: 'candidat-stable-1', searchKeyword: 'python', displayName: 'Jean', skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);

  ranker.removePeer('tcp-abc');
  assert.equal(events[events.length - 1].length, 0);

  ranker.ingestBroadcast('tcp-xyz', { peerId: 'tcp-xyz', senderId: 'candidat-stable-1', searchKeyword: 'python', displayName: 'Jean', skills: ['python'], timestamp: 2 });
  const last = events[events.length - 1];
  assert.equal(last.length, 1, 'une seule ligne, pas un doublon');
  assert.equal(last[0].peerId, 'tcp-xyz', 'le peerId de routage est mis a jour vers la connexion courante');
});
