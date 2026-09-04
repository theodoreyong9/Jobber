// src/llm/webllm.js
//
// Fine wrapper autour de @mlc-ai/web-llm. Ce module est conçu pour tourner
// DANS le Web Worker (src/worker/llm.worker.js), jamais sur le thread
// principal (§47). Il ne fait qu'appeler le modèle et valider sa sortie —
// aucune décision produit ici.

import { validateSemanticAnalysis } from '../core/validation/schema.js';
import { buildSemanticAnalysisPrompt, buildDisambiguationPrompt } from './prompts.js';

/**
 * @typedef {Object} WebLLMHandle
 * @property {(messages: any[]) => Promise<string>} chat
 */

let enginePromise = null;
let currentModelId = null;

/**
 * Charge (ou réutilise) le moteur WebLLM pour un modèle donné (§48 : éviter
 * les chargements/destructions répétitifs).
 * @param {string} modelId  Ex: "Llama-3.2-3B-Instruct-q4f16_1-MLC"
 * @param {(progress: { text: string, progress: number }) => void} [onProgress]
 * @returns {Promise<WebLLMHandle>}
 */
export async function loadEngine(modelId, onProgress) {
  if (enginePromise && currentModelId === modelId) {
    return enginePromise;
  }
  currentModelId = modelId;

  // Import direct depuis le CDN : un Web Worker n'hérite PAS de l'import map
  // déclaré dans le document principal (limitation des navigateurs), donc un
  // spécificateur "nu" comme `@mlc-ai/web-llm` ne peut pas être résolu ici.
  // On importe depuis l'URL CDN complète pour rester indépendant du contexte.
  const webllm = await import('https://esm.run/@mlc-ai/web-llm');

  const engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      onProgress?.({ text: report.text, progress: report.progress });
    },
  });

  enginePromise = Promise.resolve({
    async chat(messages) {
      const response = await engine.chat.completions.create({
        messages,
        temperature: 0.1, // faible : on veut de l'extraction fidèle, pas de créativité
        max_tokens: 800,
      });
      return response.choices?.[0]?.message?.content ?? '';
    },
    async unload() {
      await engine.unload?.();
      enginePromise = null;
      currentModelId = null;
    },
  });

  return enginePromise;
}

function parseJsonLoose(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Analyse sémantique d'un document avec retry puis fallback (§57).
 * @param {WebLLMHandle} handle
 * @param {{ kind: 'cv'|'job', text: string }} doc
 * @returns {Promise<{ ok: boolean, value: any, usedFallback: boolean }>}
 */
export async function runSemanticAnalysis(handle, doc) {
  const messages = buildSemanticAnalysisPrompt(doc);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await handle.chat(messages);
      const parsed = parseJsonLoose(raw);
      const validated = validateSemanticAnalysis(parsed);
      if (validated.ok) {
        return { ok: true, value: validated.value, usedFallback: false };
      }
      // sortie structurée mais invalide -> on retente une fois
    } catch (e) {
      // JSON invalide ou timeout -> on retente une fois
    }
  }

  // Fallback : on renvoie une analyse vide plutôt que d'inventer (§58).
  return {
    ok: false,
    usedFallback: true,
    value: { skills: [], domains: [], responsibilities: [], languages: [], seniority: null },
  };
}

/**
 * Désambiguïsation ciblée pour un match proche du seuil (§30).
 * @param {WebLLMHandle} handle
 * @param {{ candidateSkills: string[], jobRequirement: string }} params
 */
export async function runDisambiguation(handle, params) {
  const messages = buildDisambiguationPrompt(params);
  try {
    const raw = await handle.chat(messages);
    const parsed = parseJsonLoose(raw);
    if (typeof parsed.equivalent === 'boolean') return parsed;
  } catch (e) {
    // ignore, fallback ci-dessous
  }
  return { equivalent: false, matchedSkill: null, confidence: 'low' };
}
