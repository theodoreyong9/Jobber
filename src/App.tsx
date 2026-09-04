import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineKind, ModelInfo, TailoredResume, WorkerMessage } from "./types";
import { createLLMProvider } from "./llm";
import { CVUploader } from "./components/CVUploader";
import { JobOfferInput, type JobOfferDraft } from "./components/JobOfferInput";
import { EngineSelector } from "./components/EngineSelector";
import { ModelSelector } from "./components/ModelSelector";
import { ProgressBar } from "./components/ProgressBar";
import { TechnicalLog, type LogLine } from "./components/TechnicalLog";
import { loadPreferences, savePreferences } from "./storage";
import "./app.css";

function isLikelyDesktop(): boolean {
  if (typeof navigator === "undefined") return true;
  return !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

export default function App() {
  const prefs = useMemo(() => loadPreferences(), []);
  const desktop = useMemo(() => isLikelyDesktop(), []);

  const [cvFile, setCvFile] = useState<File | null>(null);
  const [offers, setOffers] = useState<JobOfferDraft[]>([{ id: crypto.randomUUID(), text: "" }]);
  const [engine, setEngine] = useState<EngineKind>(prefs.engine ?? "webllm");
  const [modelId, setModelId] = useState<string | null>(prefs.modelId ?? null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [results, setResults] = useState<TailoredResume[] | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);

  // Fetch the model catalog whenever the engine changes.
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    setModels([]);

    const provider = createLLMProvider(engine);
    provider
      .listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setModelId((current) => (list.find((m) => m.id === current) ? current : list[0]?.id ?? null));
      })
      .catch((e: Error) => {
        if (!cancelled) setModelsError(e.message);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [engine]);

  useEffect(() => {
    if (modelId) savePreferences({ engine, modelId });
  }, [engine, modelId]);

  const addLog = (level: LogLine["level"], message: string) => {
    setLogLines((prev) => [...prev, { time: new Date().toLocaleTimeString(), level, message }]);
  };

  const canStart = Boolean(cvFile) && offers.some((o) => o.text.trim().length > 0) && Boolean(modelId) && !running;

  async function handleGo() {
    if (!cvFile) {
      alert("Please select a DOCX file.");
      return;
    }
    const nonEmptyOffers = offers.filter((o) => o.text.trim().length > 0);
    if (nonEmptyOffers.length === 0) {
      alert("Please add at least one job offer.");
      return;
    }
    if (!modelId) return;

    setRunning(true);
    setResults(null);
    setErrorMsg(null);
    setProgress(0);
    setStage("Starting");
    setLogLines([]);

    const cvArrayBuffer = await cvFile.arrayBuffer();

    const worker = new Worker(new URL("./worker/llm.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        setProgress(msg.value);
        setStage(msg.stage);
      } else if (msg.type === "log") {
        addLog(msg.level, msg.message);
      } else if (msg.type === "result") {
        setResults(msg.result);
        setRunning(false);
        worker.terminate();
        workerRef.current = null;
      } else if (msg.type === "error") {
        setErrorMsg(msg.error);
        addLog("error", msg.error);
        setRunning(false);
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.postMessage(
      {
        type: "run",
        engine,
        modelId,
        cvArrayBuffer,
        cvFileName: cvFile.name,
        jobs: nonEmptyOffers.map((o, i) => ({ id: o.id, text: o.text, title: `Offer ${i + 1}` })),
      },
      [cvArrayBuffer]
    );
  }

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1>JOBBER</h1>
        <p>Adapt your CV. No account needed. Your CV stays on your device.</p>
      </header>

      <section className="app__section">
        <h2>CV</h2>
        <CVUploader fileName={cvFile?.name ?? null} onFileSelected={setCvFile} />
      </section>

      <section className="app__section">
        <h2>Job offers</h2>
        <JobOfferInput offers={offers} onChange={setOffers} />
      </section>

      <section className="app__section">
        <h2>AI engine</h2>
        <EngineSelector value={engine} onChange={setEngine} allowLocal={desktop} />
      </section>

      <section className="app__section">
        <h2>Model</h2>
        <ModelSelector
          models={models}
          value={modelId}
          onChange={setModelId}
          loading={modelsLoading}
          error={modelsError}
        />
      </section>

      <button className="app__go" disabled={!canStart} onClick={handleGo}>
        {running ? "Working…" : "GO"}
      </button>

      {running && <ProgressBar value={progress} stage={stage} />}

      {errorMsg && <p className="app__error">{errorMsg}</p>}

      {results && (
        <section className="app__section">
          <h2>Results</h2>
          <ul className="app__results">
            {results.map((r) => (
              <li key={r.jobId}>
                <a href={URL.createObjectURL(r.blob)} download={r.fileName}>
                  ⬇ {r.fileName}
                </a>
                {!r.validation.ok && (
                  <span className="app__results-warning"> — some sections kept the original wording (validation)</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <TechnicalLog lines={logLines} />
    </div>
  );
}
