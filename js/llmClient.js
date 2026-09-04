// Wrapper côté thread principal : parle au Web Worker (js/llmWorker.js)
// via postMessage, expose une API à base de Promises, et sait tout
// détruire proprement (moteur WebLLM + worker) une fois le travail fini.

let msgCounter = 0;
function nextId() {
  return ++msgCounter;
}

export class LLMClient {
  constructor() {
    this.worker = null;
    this.pending = new Map();
  }

  start(onModelProgress) {
    this.worker = new Worker(new URL("./llmWorker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => {
      const { type, id, payload } = event.data;
      if (type === "model-progress") {
        onModelProgress?.(payload);
        return;
      }
      const resolver = this.pending.get(id);
      if (!resolver) return;
      this.pending.delete(id);
      if (type === "error") {
        resolver.reject(new Error(payload.message));
      } else {
        resolver.resolve(payload);
      }
    };
  }

  _send(type, payload) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, payload });
    });
  }

  async loadModel(model) {
    await this._send("init", { model });
  }

  async generate(systemPrompt, prompt) {
    const { text } = await this._send("generate", { systemPrompt, prompt });
    return text;
  }

  /**
   * Etape 18 : détruit l'instance WebLLM ET le worker qui l'héberge.
   */
  async terminate() {
    if (!this.worker) return;
    try {
      await this._send("terminate", {});
    } catch {
      // le worker peut déjà avoir fermé sa connexion, on force quand même
    }
    this.worker.terminate();
    this.worker = null;
  }
}
