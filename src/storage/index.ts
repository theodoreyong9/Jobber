import type { EngineKind } from "../types";

const KEYS = {
  engine: "jobber:lastEngine",
  model: "jobber:lastModel",
} as const;

export interface JobberPreferences {
  engine?: EngineKind;
  modelId?: string;
}

/**
 * Only lightweight preferences are persisted (last engine/model choice).
 * The CV, job offers, and any generated content are never written to
 * localStorage/IndexedDB by Jobber itself — per the confidentiality
 * principle "your CV stays on your device" (and never touches storage
 * either, beyond the in-memory session).
 */
export function loadPreferences(): JobberPreferences {
  try {
    const engine = localStorage.getItem(KEYS.engine) as EngineKind | null;
    const modelId = localStorage.getItem(KEYS.model);
    return { engine: engine ?? undefined, modelId: modelId ?? undefined };
  } catch {
    return {};
  }
}

export function savePreferences(prefs: JobberPreferences): void {
  try {
    if (prefs.engine) localStorage.setItem(KEYS.engine, prefs.engine);
    if (prefs.modelId) localStorage.setItem(KEYS.model, prefs.modelId);
  } catch {
    /* storage may be unavailable (private browsing); fail silently */
  }
}
