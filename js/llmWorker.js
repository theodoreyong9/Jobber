// Web Worker dédié à WebLLM. Tourne hors du thread principal pour ne pas
// geler l'UI pendant le chargement du modèle et la génération.
// Détruit son moteur WebLLM à la demande (step 18), puis se referme
// lui-même (self.close()) : à la fin d'une génération, plus aucune trace
// du modèle ne reste en mémoire.

import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

let engine = null;

self.onmessage = async (event) => {
  const { type, payload, id } = event.data;

  try {
    if (type === "init") {
      engine = await CreateMLCEngine(payload.model, {
        initProgressCallback: (report) => {
          self.postMessage({ type: "model-progress", payload: report });
        },
      });
      self.postMessage({ type: "init-done", id });
    }

    if (type === "generate") {
      const { prompt, systemPrompt } = payload;
      const completion = await engine.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      });
      const text = completion.choices?.[0]?.message?.content ?? "";
      self.postMessage({ type: "generate-done", id, payload: { text } });
    }

    if (type === "terminate") {
      if (engine && typeof engine.unload === "function") {
        await engine.unload();
      }
      engine = null;
      self.postMessage({ type: "terminate-done", id });
      self.close(); // détruit le worker lui-même
    }
  } catch (err) {
    self.postMessage({ type: "error", id, payload: { message: err?.message || String(err) } });
  }
};
