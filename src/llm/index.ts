import type { EngineKind, LLMProvider } from "../types";
import { WebLLMProvider } from "./WebLLMProvider";
import { LocalProvider } from "./LocalProvider";

export function createLLMProvider(engine: EngineKind): LLMProvider {
  switch (engine) {
    case "webllm":
      return new WebLLMProvider();
    case "local":
      return new LocalProvider();
    default:
      throw new Error(`Unknown engine: ${engine}`);
  }
}

export { WEBLLM_CATALOG } from "./WebLLMProvider";
export { OllamaAdapter } from "./LocalProvider";
