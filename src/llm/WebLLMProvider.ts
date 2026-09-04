import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo } from "../types";

/**
 * Curated catalogue of WebLLM models Jobber officially supports.
 * These ids must match entries in @mlc-ai/web-llm's prebuiltAppConfig.
 */
export const WEBLLM_CATALOG: ModelInfo[] = [
  {
    id: "Qwen2.5-7B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 7B Instruct",
    provider: "webllm",
    size: "~4.5 GB",
    contextLength: 32768,
    capabilities: { multilingual: true, json: true, rewriting: true },
    recommendation: "recommended",
  },
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 3B Instruct",
    provider: "webllm",
    size: "~2 GB",
    contextLength: 32768,
    capabilities: { multilingual: true, json: true, rewriting: true },
    recommendation: "recommended",
    note: "Best choice for mobile / low-memory devices.",
  },
  {
    id: "Llama-3.1-8B-Instruct-q4f16_1-MLC",
    name: "Llama 3.1 8B Instruct",
    provider: "webllm",
    size: "~5 GB",
    contextLength: 8192,
    capabilities: { multilingual: true, json: true, rewriting: true },
    recommendation: "heavy",
  },
  {
    id: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    name: "Phi 3.5 Mini Instruct",
    provider: "webllm",
    size: "~2.4 GB",
    contextLength: 4096,
    capabilities: { multilingual: false, json: true, rewriting: true },
    recommendation: "limited",
    note: "Weaker multilingual rewriting, fast to load.",
  },
];

export class WebLLMProvider implements LLMProvider {
  private engine: import("@mlc-ai/web-llm").MLCEngineInterface | null = null;
  private loadedModelId: string | null = null;

  async listModels(): Promise<ModelInfo[]> {
    return WEBLLM_CATALOG;
  }

  async load(modelId: string, onProgress?: (pct: number, text: string) => void): Promise<void> {
    if (this.engine && this.loadedModelId === modelId) return;
    if (this.engine) await this.destroy();

    const webllm = await import("@mlc-ai/web-llm");

    this.engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        onProgress?.(Math.round((report.progress ?? 0) * 100), report.text ?? "Loading model");
      },
    });
    this.loadedModelId = modelId;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.engine) throw new Error("WebLLM engine not loaded.");

    const reply = await this.engine.chat.completions.create({
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 800,
      response_format: request.jsonMode ? { type: "json_object" } : undefined,
    });

    const text = reply.choices?.[0]?.message?.content ?? "";
    return { text, raw: reply };
  }

  async destroy(): Promise<void> {
    if (this.engine) {
      await this.engine.unload();
      this.engine = null;
      this.loadedModelId = null;
    }
  }
}
