import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomRanker, candidateBroadcastToComparable, matchesKeywordGate } from '../src/p2p/discovery.js';
import { buildJobProfile } from '../src/core/extraction/buildProfile.js';

function jobWithSkill(skill, extra = {}) {
  return buildJobProfile({ documentId: 'job1', facts: [{ id: '1', field: 'skill', value: skill, sourceDocumentId: 'job1' }], rawText: '', ...extra });
}

test('une diffusion dont le mot-cle ne correspond a rien dans la salle est ignoree avant toute analyse', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand0', { peerId: 'cand0', searchKeywords: ['photographie'], skills: ['python'], timestamp: 1 });
  assert.equal(events.length, 0, 'aucun evenement ne doit etre emis pour une diffusion filtree par mot-cle');
});

test('un mot-cle qui correspond au titre de la salle passe le filtre', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand1', { peerId: 'cand1', searchKeywords: ['data'], skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);
});

test('un mot-cle qui correspond a une competence de la salle passe le filtre', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Poste sans rapport');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand2', { peerId: 'cand2', searchKeywords: ['python'], skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);
});

test('changer de mot-cle vers un sujet hors annonce retire le candidat du classement', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeywords: ['python'], skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);

  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeywords: ['photographie'], skills: ['python'], timestamp: 2 });
  assert.equal(events[events.length - 1].length, 0);
});

test('matchesKeywordGate ignore casse et accents', () => {
  const set = new Set(['data', 'python']);
  assert.equal(matchesKeywordGate('Data', set), true);
  assert.equal(matchesKeywordGate('DATA', set), true);
  assert.equal(matchesKeywordGate('js', set), false);
});

test('RoomRanker score une diffusion candidat pertinente et la classe (compte brut de mots-cles)', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'python');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand1', { peerId: 'cand1', searchKeywords: ['python'], displayName: 'Jean', skills: ['python'], cvFileName: 'cv.docx', timestamp: 1 });

  const last = events[events.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].displayName, 'Jean');
  assert.equal(last[0].cvFileName, 'cv.docx');
  assert.equal(last[0].total, 1);
});

test('RoomRanker filtre les diffusions sans aucun recoupement', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'python');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand2', { peerId: 'cand2', displayName: 'Ana', searchKeywords: ['python'], skills: ['photographie'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 0, 'aucune ligne dans le classement, meme si un evenement a ete emis');
});

test('RoomRanker deduplique une diffusion identique (meme horodatage)', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'python');
  let emitCount = 0;
  ranker.onRankingChange(() => { emitCount += 1; });

  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeywords: ['python'], skills: ['python'], timestamp: 42 });
  ranker.ingestBroadcast('cand3', { peerId: 'cand3', searchKeywords: ['python'], skills: ['python'], timestamp: 42 });
  assert.equal(emitCount, 1, 'la seconde diffusion identique ne doit pas redeclencher un evenement');
});

test('RoomRanker.removePeer retire un candidat du classement', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'python');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('cand5', { peerId: 'cand5', searchKeywords: ['python'], skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);

  ranker.removePeer('cand5');
  assert.equal(events[events.length - 1].length, 0);
});

test('candidateBroadcastToComparable ne fabrique jamais de texte integral et porte ville/anciennete', () => {
  const comparable = candidateBroadcastToComparable({ peerId: 'p1', skills: ['sql'], cities: ['Lyon'], yearsOfExperience: 4 });
  assert.equal(comparable.id, 'p1');
  assert.deepEqual(comparable.cities, ['lyon']);
  assert.equal(comparable.yearsOfExperience, 4);
  assert.ok(!('fullText' in comparable));
});

test('un candidat reconnecte (nouveau peerId de transport, meme senderId) met a jour sa ligne au lieu d\'en creer une nouvelle', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('tcp-abc', { peerId: 'tcp-abc', senderId: 'candidat-stable-1', searchKeywords: ['python'], displayName: 'Jean', skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);

  ranker.removePeer('tcp-abc');
  assert.equal(events[events.length - 1].length, 0);

  ranker.ingestBroadcast('tcp-xyz', { peerId: 'tcp-xyz', senderId: 'candidat-stable-1', searchKeywords: ['python'], displayName: 'Jean', skills: ['python'], timestamp: 2 });
  const last = events[events.length - 1];
  assert.equal(last.length, 1, 'une seule ligne, pas un doublon');
  assert.equal(last[0].peerId, 'tcp-xyz', 'le peerId de routage est mis a jour vers la connexion courante');
});

test('retireIdentity retire immediatement une identite sans attendre une deconnexion', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('tcp-1', { peerId: 'tcp-1', senderId: 'candidat-a', searchKeywords: ['python'], skills: ['python'], timestamp: 1 });
  assert.equal(events[events.length - 1].length, 1);

  ranker.retireIdentity('candidat-a');
  assert.equal(events[events.length - 1].length, 0);
});

test('removePeer nettoie toutes les identites vues depuis un meme peerId de transport (rotation en direct)', () => {
  const job = jobWithSkill('python');
  const ranker = new RoomRanker(job, 'Data Engineer');
  const events = [];
  ranker.onRankingChange((r) => events.push(r));

  ranker.ingestBroadcast('tcp-rot', { peerId: 'tcp-rot', senderId: 'ancien-id', searchKeywords: ['python'], skills: ['python'], timestamp: 1 });
  ranker.ingestBroadcast('tcp-rot', { peerId: 'tcp-rot', senderId: 'nouvel-id', searchKeywords: ['python'], skills: ['python'], timestamp: 2 });

  ranker.removePeer('tcp-rot');
  const last = events[events.length - 1];
  assert.equal(last.length, 0, 'plus aucune ligne, meme fantome, apres la deconnexion');
});
