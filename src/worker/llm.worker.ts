/// <reference lib="webworker" />
import type { WorkerCommand, WorkerMessage } from "../types";
import { createLLMProvider } from "../llm";
import { runPipeline } from "../core/pipeline/pipeline";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerMessage) {
  ctx.postMessage(message);
}

ctx.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;

  // Model listing is cheap (static catalog for WebLLM, one fetch() for
  // Ollama) and is done directly on the main thread — see src/llm usage in
  // ModelSelector — so the worker only ever needs to handle "run".
  if (command.type === "run") {
    const provider = createLLMProvider(command.engine);
    try {
      post({ type: "progress", value: 0, stage: "Loading model" });
      await provider.load(command.modelId, (pct, text) => {
        post({ type: "progress", value: Math.min(9, Math.round(pct / 11)), stage: text });
      });
      post({ type: "log", level: "info", message: `Model ${command.modelId} loaded` });

      const results = await runPipeline(
        provider,
        command.cvArrayBuffer,
        command.cvFileName,
        command.jobs,
        {
          onProgress: (value, stage) => post({ type: "progress", value, stage }),
          onLog: (level, message) => post({ type: "log", level, message }),
        }
      );

      post({ type: "result", result: results });
    } catch (e) {
      post({ type: "error", error: (e as Error).message });
    } finally {
      try {
        await provider.destroy();
      } catch {
        /* best effort */
      }
    }
  }
};
