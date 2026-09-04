// src/worker/llm.worker.js
//
// Tourne dans un Web Worker dédié. Reçoit des commandes du thread principal
// (via src/llm/provider.js) et délègue au wrapper WebLLM. Aucune logique
// produit ici — uniquement de l'orchestration technique du modèle.

import { loadEngine, runSemanticAnalysis, runDisambiguation } from '../llm/webllm.js';

/** @type {import('../llm/webllm.js').WebLLMHandle | null} */
let handle = null;
let loadedModelId = null;

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    const result = await dispatch(type, payload);
    self.postMessage({ id, type, payload: result });
  } catch (err) {
    self.postMessage({ id, type, error: err?.message || String(err) });
  }
});

async function dispatch(type, payload) {
  switch (type) {
    case 'load_model': {
      if (handle && loadedModelId === payload.modelId) return { alreadyLoaded: true };
      handle = await loadEngine(payload.modelId, (progress) => {
        self.postMessage({ type: 'progress', payload: progress });
      });
      loadedModelId = payload.modelId;
      return { alreadyLoaded: false };
    }
    case 'analyze_document': {
      if (!handle) throw new Error('Modèle non chargé : appeler load_model avant analyze_document.');
      return runSemanticAnalysis(handle, { kind: payload.kind, text: payload.text });
    }
    case 'disambiguate': {
      if (!handle) throw new Error('Modèle non chargé : appeler load_model avant disambiguate.');
      return runDisambiguation(handle, payload);
    }
    case 'unload_model': {
      if (handle?.unload) await handle.unload();
      handle = null;
      loadedModelId = null;
      return { unloaded: true };
    }
    default:
      throw new Error(`Commande worker inconnue : ${type}`);
  }
}
