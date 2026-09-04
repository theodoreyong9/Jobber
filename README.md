# Jobber

Adapt your CV to a job offer — locally, privately, with no account and no cloud.

Jobber is a client-only Progressive Web App. Your CV never leaves your
device: inference runs either in-browser via **WebLLM** or against a
**local engine** (Ollama) on your own machine. There is no backend, no
account, and no server-side storage.

> **Jobber never invents facts.** It can reformulate, reorder, translate and
> re-emphasize what's already in your CV — it cannot add an employer, a
> technology, a date, a number, or a qualification that isn't already there.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
npm run preview  # serve the production build locally
```

Deploys as static assets — GitHub Pages, Netlify, Vercel static, or any
static host all work with no server component.

## How it works

```
CV.docx + Job offer(s)
        │
        ▼
CPU: parse DOCX → ResumeSource (Fact Bank)
        │
        ▼
For each job offer
  ├─ detect language
  ├─ extract keywords + "adapters" (job-side phrasing)
  ├─ match resume sections ↔ adapters (lexical overlap, max 3/section)
  └─ build a RewritePlan (original text + authorized facts + adapters + rules)
        │
        ▼
LLM (WebLLM or local model, in a Web Worker)
  → strict JSON: { paragraphId, text }[]
        │
        ▼
CPU validation
  ├─ numbers preserved?
  ├─ length not exploded?
  ├─ paragraphId known?
  └─ JSON well-formed? (2 retries, else keep original text)
        │
        ▼
DOCX patcher — rewrites only the targeted <w:t> runs,
everything else (images, tables, styles, headers/footers) untouched
        │
        ▼
DOCX validator — re-opens the ZIP, checks XML + media survived
        │
        ▼
Download: "My CV - Company A.docx"
```

The philosophy, restated:

- **CPU** to parse, structure, extract and validate — deterministic, cheap,
  auditable.
- **LLM** only to reformulate a small, explicitly scoped chunk of text.
- **CPU again** to check the LLM didn't cross any line.
- **The original DOCX** is patched in place, never rebuilt from scratch —
  so layout, images, and styles survive.

## Project layout

```
src/
├── App.tsx                    # single-screen UI, orchestrates the worker
├── components/                # CVUploader, JobOfferInput, EngineSelector,
│                               # ModelSelector, ProgressBar, TechnicalLog
├── core/
│   ├── resume/                 # section detection, fact/keyword extraction
│   ├── jobs/                   # job offer parsing, adapter extraction
│   ├── matching/                # lexical resume ↔ job matching
│   ├── rewriting/                 # RewritePlan + prompt building
│   ├── validation/                 # CPU-side output validation
│   └── pipeline/                    # end-to-end orchestration
├── docx/
│   ├── parser.ts               # DOCX → ParagraphFeatures[]
│   ├── patcher.ts               # targeted run rewriting
│   └── validator.ts              # post-patch ZIP/XML/media sanity checks
├── llm/
│   ├── (types in ../types)      # common LLMProvider interface
│   ├── WebLLMProvider.ts         # @mlc-ai/web-llm, curated model catalog
│   └── LocalProvider.ts           # Ollama adapter, dynamic model discovery
├── worker/llm.worker.ts          # runs the model + pipeline off the main thread
├── storage/                       # persists engine/model preference only
└── types/index.ts                 # all shared data models
```

## Extending

- **New local engine**: implement `LocalEngineAdapter` (see
  `src/llm/LocalProvider.ts`) and pass it into `new LocalProvider(adapter)`.
- **New WebLLM model**: add an entry to `WEBLLM_CATALOG` in
  `src/llm/WebLLMProvider.ts` — the `id` must match an entry in WebLLM's
  `prebuiltAppConfig`.
- **Other CV formats**: the DOCX-specific code is isolated in `src/docx/`;
  a new format needs its own parser/patcher/validator implementing an
  analogous contract, feeding the same `ResumeSource` shape.

## Known limitations (v1)

- Paragraph rewriting collapses a paragraph's runs into a single run (the
  first run's formatting is kept, later runs are dropped). This guarantees
  structural validity but loses *inline* mixed formatting (e.g. one bold
  word inside an otherwise plain sentence) inside a rewritten paragraph.
  Non-targeted paragraphs are never touched.
- Section detection and keyword/adapter extraction are heuristic
  (font-size/bold/regex based), not ML-based — by design, to keep the
  pipeline auditable and keep the LLM's job narrowly scoped.
- The WebLLM runtime is fetched and cached lazily (only when you pick the
  WebLLM engine and click **GO**), so it doesn't bloat the initial page
  load, but first run on a new device will download the selected model
  (hundreds of MB to a few GB depending on the model).
