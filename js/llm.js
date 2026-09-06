// llm.js — optional local AI. Nothing here is required for the app to work:
// the CPU pipeline in matching.js is always available. When a device
// supports WebGPU, this loads a small model directly in the browser (via
// WebLLM) with no server involved — weights are fetched by the browser from
// the model's public host and cached locally by the browser afterwards.

const DEFAULT_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

let enginePromise = null;
let currentModel = null;

export function isWebGPUAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export async function getEngine(modelId = DEFAULT_MODEL, onProgress) {
  if (!isWebGPUAvailable()) {
    throw new Error('WebGPU is not available on this device — local AI is disabled, CPU pipeline still works.');
  }
  if (enginePromise && currentModel === modelId) return enginePromise;

  currentModel = modelId;
  enginePromise = import('https://esm.sh/@mlc-ai/web-llm').then((webllm) =>
    webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => onProgress && onProgress(p),
    })
  );
  return enginePromise;
}

export async function enrichKeywords(rawText, onProgress) {
  const engine = await getEngine(undefined, onProgress);
  const res = await engine.chat.completions.create({
    messages: [
      {
        role: 'system',
        content:
          'You extract concise professional keywords and concepts from text. Reply with a comma-separated list only — no sentences, no preamble.',
      },
      { role: 'user', content: rawText.slice(0, 4000) },
    ],
    temperature: 0.2,
  });
  const text = res.choices[0]?.message?.content || '';
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
}

export async function researchGenerate(userPrompt, systemPrompt, onProgress) {
  const engine = await getEngine(undefined, onProgress);
  const res = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.6,
  });
  return res.choices[0]?.message?.content || '';
}
