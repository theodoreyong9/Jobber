import test from 'node:test';
import assert from 'node:assert/strict';

import { runKeywordBoost } from '../src/llm/webllm.js';

function mockHandle(response) {
  return { chat: async () => response };
}

function baseParams(overrides = {}) {
  return {
    cvText: 'texte du cv',
    currentKeywords: ['python'],
    ...overrides,
  };
}

test('runKeywordBoost renvoie ok:true avec des mots-cles additionnels pour une reponse JSON valide', async () => {
  const handle = mockHandle(JSON.stringify({ keywords: ['data engineering', 'etl'] }));
  const result = await runKeywordBoost(handle, baseParams());
  assert.equal(result.ok, true);
  assert.deepEqual(result.keywords, ['data engineering', 'etl']);
});

test('runKeywordBoost tronque a 10 mots-cles maximum', async () => {
  const many = Array.from({ length: 20 }, (_, i) => `mot${i}`);
  const handle = mockHandle(JSON.stringify({ keywords: many }));
  const result = await runKeywordBoost(handle, baseParams());
  assert.equal(result.ok, true);
  assert.equal(result.keywords.length, 10);
});

test('runKeywordBoost renvoie ok:false (jamais d\'exception) sur un JSON invalide', async () => {
  const handle = mockHandle('ceci n\'est pas du JSON');
  const result = await runKeywordBoost(handle, baseParams());
  assert.equal(result.ok, false);
});

test('runKeywordBoost renvoie ok:false si "keywords" n\'est pas un tableau', async () => {
  const handle = mockHandle(JSON.stringify({ keywords: 'pas un tableau' }));
  const result = await runKeywordBoost(handle, baseParams());
  assert.equal(result.ok, false);
});

test('runKeywordBoost renvoie ok:false si le modele leve une exception (§ le candidat doit toujours pouvoir partir avec ses mots-cles CPU)', async () => {
  const handle = { chat: async () => { throw new Error('modele indisponible'); } };
  const result = await runKeywordBoost(handle, baseParams());
  assert.equal(result.ok, false);
});
