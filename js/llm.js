// llm.js — optional local AI. Nothing here is required for the app to work:
// the CPU pipeline in matching.js is always available. When a device
// supports WebGPU, this loads a small model directly in the browser (via
// WebLLM) with no server involved — weights are fetched by the browser from
// the model's public host and cached locally by the browser afterwards.
//
// Loaded from esm.run (jsdelivr's dedicated ESM endpoint — the same one
// WebLLM's own docs use for no-bundler browser usage) rather than esm.sh:
// esm.sh's CJS interop shim for this package tries to polyfill Node's
// `createRequire`, which doesn't exist in a browser and throws immediately.
//
// Model choice: the only job this does is turn CPU-extracted keywords into
// a slightly richer keyword list — not open-ended chat — so it deliberately
// defaults to one of the smallest instruct models WebLLM ships (135M
// params, ~720MB VRAM) rather than a general 1B+ chat model. A bigger model
// doesn't make "expand these keywords" meaningfully better, and it does
// make a low-VRAM GPU far more likely to hit a driver-level "device lost"
// reset mid-inference.

const DEFAULT_MODEL = 'SmolLM2-135M-Instruct-q0f32-MLC';
const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm';

let enginePromise = null;
let currentModel = null;

export function isWebGPUAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// A WebGPU "device lost" is a driver/OS-level reset, not a normal JS
// exception — the engine object left behind is unusable. The only correct
// recovery is to throw the cached engine away so the next attempt builds a
// fresh GPU device from scratch, rather than reusing a dead one forever.
function isDeviceLostError(e) {
  return /device (was |has been )?lost/i.test(String(e?.message || e));
}

export function friendlyLlmError(e) {
  if (isDeviceLostError(e)) {
    return 'The GPU reset mid-inference (out of VRAM or a driver hiccup) — this is the browser/GPU, not a bug in Jobber. Try again; the model will reload from cache so it should be quick. If it keeps happening, close other GPU-heavy tabs or apps first.';
  }
  return String(e?.message || e);
}

function resetEngine() {
  enginePromise = null;
  currentModel = null;
}

export async function getEngine(modelId = DEFAULT_MODEL, onProgress) {
  if (!isWebGPUAvailable()) {
    throw new Error('WebGPU is not available on this device — local AI is disabled, CPU pipeline still works.');
  }
  if (enginePromise && currentModel === modelId) return enginePromise;

  currentModel = modelId;
  enginePromise = import(WEBLLM_URL).then((webllm) =>
    webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => onProgress && onProgress(p),
    })
  );
  return enginePromise;
}

async function runChatCompletion(messages, temperature, onProgress) {
  const engine = await getEngine(undefined, onProgress);
  try {
    const res = await engine.chat.completions.create({ messages, temperature });
    return res.choices[0]?.message?.content || '';
  } catch (e) {
    if (isDeviceLostError(e)) resetEngine(); // don't keep handing out a dead engine
    throw new Error(friendlyLlmError(e));
  }
}

export async function enrichKeywords(rawText, onProgress) {
  const text = await runChatCompletion(
    [
      {
        role: 'system',
        content:
          'You extract concise professional keywords and concepts from text. Reply with a comma-separated list only — no sentences, no preamble.',
      },
      { role: 'user', content: rawText.slice(0, 4000) },
    ],
    0.2,
    onProgress
  );
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
}

export async function researchGenerate(userPrompt, systemPrompt, onProgress) {
  return runChatCompletion(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    0.6,
    onProgress
  );
}
