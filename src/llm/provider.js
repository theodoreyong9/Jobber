// src/llm/provider.js
//
// Façade utilisée par l'UI / le cœur applicatif pour parler au Web Worker
// WebLLM sans jamais bloquer le thread principal (§47). Gère le cycle de
// vie du modèle (§48) et expose une API basée sur des promesses au-dessus
// de postMessage.

/** @type {Worker|null} */
let worker = null;
let requestCounter = 0;
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pending = new Map();
/** @type {Set<(p:{text:string,progress:number}) => void>} */
const progressListeners = new Set();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../worker/llm.worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event) => {
    const { id, type, payload, error } = event.data || {};
    if (type === 'progress') {
      progressListeners.forEach((fn) => fn(payload));
      return;
    }
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(error));
    else entry.resolve(payload);
  });
  return worker;
}

function call(type, payload) {
  const w = ensureWorker();
  const id = (requestCounter += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
  });
}

/** S'abonne à la progression du chargement du modèle (§78). */
export function onModelProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

/** Charge un modèle (no-op si déjà chargé) (§48, §78). */
export function loadModel(modelId) {
  return call('load_model', { modelId });
}

/** Lance l'analyse sémantique d'un document déjà parsé en texte. */
export function analyzeDocument(kind, text) {
  return call('analyze_document', { kind, text });
}

/** Désambiguïsation ciblée pour un match ambigu (§30). */
export function disambiguate(candidateSkills, jobRequirement) {
  return call('disambiguate', { candidateSkills, jobRequirement });
}

/**
 * "Boost" optionnel côté candidat (§ demande : IA côté candidat, pas côté
 * annonceur) : suggère des mots-clés additionnels à partir du CV, avant
 * l'envoi. Ne rejette jamais côté worker (voir llm.worker.js) — mais on
 * garde un try/catch ici aussi, en dernier recours (ex: Worker mort,
 * postMessage qui échoue), pour qu'un problème GPU ne remonte JAMAIS comme
 * une exception non gérée jusqu'au code appelant : le candidat doit
 * toujours pouvoir passer en direct avec ses seuls mots-clés CPU.
 * @returns {Promise<{ ok: true, keywords: string[] } | { ok: false }>}
 */
export async function boostKeywords(params) {
  try {
    return await call('boost_keywords', params);
  } catch (e) {
    return { ok: false };
  }
}

/** Détecte si WebGPU est disponible dans ce navigateur (§80-81). */
export async function detectWebGpuSupport() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

export function unloadModel() {
  return call('unload_model', {});
}
