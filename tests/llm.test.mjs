import test from 'node:test';
import assert from 'node:assert/strict';

import { runRelevanceScoring } from '../src/llm/webllm.js';

function mockHandle(response) {
  return { chat: async () => response };
}

function baseParams(overrides = {}) {
  return {
    jobText: 'texte annonce',
    jobStructured: { skills: ['python'], domains: [], seniority: null, locations: [], languages: [] },
    candidate: { searchKeyword: 'python', skills: ['python'], domains: [], seniority: null, yearsOfExperience: null, locations: [], languages: [] },
    ...overrides,
  };
}

test('runRelevanceScoring renvoie ok:true pour une réponse JSON valide', async () => {
  const handle = mockHandle(JSON.stringify({ score: 82, justification: 'Bon recoupement des compétences.' }));
  const result = await runRelevanceScoring(handle, baseParams());
  assert.equal(result.ok, true);
  assert.equal(result.score, 82);
});

test('runRelevanceScoring renvoie ok:false (jamais d\'exception) sur un JSON invalide', async () => {
  const handle = mockHandle('ceci n\'est pas du JSON');
  const result = await runRelevanceScoring(handle, baseParams());
  assert.equal(result.ok, false);
});

test('runRelevanceScoring renvoie ok:false sur un score hors bornes (§ perte de GPU ne doit pas tout tuer)', async () => {
  const handle = mockHandle(JSON.stringify({ score: 150, justification: 'x' }));
  const result = await runRelevanceScoring(handle, baseParams());
  assert.equal(result.ok, false);
});

test('runRelevanceScoring renvoie ok:false si le modèle lève une exception', async () => {
  const handle = { chat: async () => { throw new Error('modèle indisponible'); } };
  const result = await runRelevanceScoring(handle, baseParams());
  assert.equal(result.ok, false);
});
