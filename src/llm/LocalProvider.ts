import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo } from "../types";

export interface LocalEngineAdapter {
  /** Human readable name, e.g. "Ollama". */
  name: string;
  baseUrl: string;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  generate(modelId: string, request: LLMRequest): Promise<LLMResponse>;
}

/**
 * Adapter for a locally running Ollama instance (http://localhost:11434).
 * Jobber never installs or manages the engine itself — it only talks to it.
 */
export class OllamaAdapter implements LocalEngineAdapter {
  name = "Ollama";
  baseUrl: string;

  constructor(baseUrl = "http://localhost:11434") {
    this.baseUrl = baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error("Could not reach the local model engine.");
    const data = (await res.json()) as { models?: { name: string; size?: number }[] };

    return (data.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      provider: "local" as const,
      size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : undefined,
      capabilities: { multilingual: true, json: true, rewriting: true },
      recommendation: guessRecommendation(m.name),
    }));
  }

  async generate(modelId: string, request: LLMRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        stream: false,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        format: request.jsonMode ? "json" : undefined,
        options: {
          temperature: request.temperature ?? 0.2,
          num_predict: request.maxTokens ?? 800,
        },
      }),
    });

    if (!res.ok) throw new Error(`Local engine error: ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return { text: data.message?.content ?? "", raw: data };
  }
}

function guessRecommendation(name: string): ModelInfo["recommendation"] {
  const n = name.toLowerCase();
  if (n.includes("70b") || n.includes("32b")) return "heavy";
  if (n.includes("8b") || n.includes("7b") || n.includes("9b")) return "recommended";
  if (n.includes("1b") || n.includes("2b") || n.includes("3b")) return "limited";
  return "recommended";
}

export class LocalProvider implements LLMProvider {
  private adapter: LocalEngineAdapter;
  private loadedModelId: string | null = null;

  constructor(adapter: LocalEngineAdapter = new OllamaAdapter()) {
    this.adapter = adapter;
  }

  async listModels(): Promise<ModelInfo[]> {
    const available = await this.adapter.isAvailable();
    if (!available) {
      throw new Error("The local model engine could not be reached.");
    }
    return this.adapter.listModels();
  }

  async load(modelId: string, onProgress?: (pct: number, text: string) => void): Promise<void> {
    // Local models are already resident in the engine; nothing to download.
    onProgress?.(100, `Using local model ${modelId}`);
    this.loadedModelId = modelId;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.loadedModelId) throw new Error("No local model selected.");
    return this.adapter.generate(this.loadedModelId, request);
  }

  async destroy(): Promise<void> {
    this.loadedModelId = null;
  }
}
