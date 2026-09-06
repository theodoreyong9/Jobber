# Jobber — Personal Interoperable Agency

A local-first, peer-to-peer web app. No backend, no central database, no
build step: plain HTML, CSS and ES modules.

Everything below is **real, running code** — not a mockup wired to fake
data. Identity is a real ECDSA keypair generated in your browser. Storage is
real IndexedDB. Networking is real WebRTC via Trystero. Matching runs a real
local scoring algorithm. Local AI, when your device supports it, is a real
WebLLM model running in-browser. Research artifacts are real records with
real provenance, exportable as a real file.

## Run it

Browsers block ES module imports and service workers on the bare `file://`
protocol, so serve the folder over HTTP:

```bash
npx serve .
# or: python3 -m http.server 8080
```

Then open the printed local URL in **two separate browser tabs, windows, or
devices** — Jobber talks to itself over real peer-to-peer connections, so a
single tab alone will never discover a peer. That's expected, not a bug.

## What each module actually does

| File | Real behavior |
|---|---|
| `js/db.js` | IndexedDB wrapper: identities, profiles, cache, conversations, research projects/artifacts. Nothing here is a server call. |
| `js/identity.js` | Generates a real ECDSA P-256 keypair per identity via WebCrypto. The identity id is a SHA-256 hash of the public key. Rotation generates a fresh keypair and marks the old one retired; retirement is local-only (there's no global authority to enforce it network-wide — the UI says so). |
| `js/protocol.js` | The actual wire format (`v`, `type`, `namespace`, `sender`, `messageId`, `timestamp`, `payload`) and validation used by every message before it's trusted. |
| `js/p2p.js` | Real WebRTC data channels via [Trystero](https://github.com/dmotz/trystero) (`torrent` strategy — public BitTorrent trackers are used only so two browsers can find each other's connection info; no app data passes through them). One room per namespace. |
| `js/discovery.js` | The real cascade: namespace/protocol match → hard filters → soft ranking → budget cap, before anything expensive runs. |
| `js/matching.js` | Deterministic local scoring: tokenize → synonym-normalize → Jaccard overlap → penalty for missing required terms. Versioned (`MATCHING_ENGINE_VERSION`), same formula regardless of whether AI enrichment is on. |
| `js/llm.js` | Loads [WebLLM](https://github.com/mlc-ai/web-llm) only if `navigator.gpu` exists, and only when you click "enrich" — never automatically. Runs a small instruction model entirely client-side. |
| `js/research.js` | Research Vault: projects, typed artifacts (`hypothesis`, `critique`, `experiment`, `result`, …), parent/child provenance, export to a `project.jobber` JSON bundle, import back in. |
| `js/app.js` | Wires all of the above to the UI: identity switcher, profile editor, live discovery + ranked matches, P2P chat, and the Research graph/feed/contract panel. |

## Deliberate simplifications (so you know where the edges are)

- **No PDF/résumé parsing.** You paste text or load a `.txt` file. Real
  document parsing (PDF/DOCX) is a separate, addable module — not faked here.
- **No precise geolocation.** Distance-based hard filtering is wired but
  nothing populates `distanceKm` yet; add a manual "approximate area" field
  or the Geolocation API if you want it live.
- **`job_candidate` covers both sides of Employment.** The full spec splits
  `job_candidate` / `job_recruiter`; this build matches symmetrically in one
  namespace to keep the identity model simple. Splitting it back out is a
  matter of adding a second namespace entry with the same code path.
- **Human-in-the-loop is a single toggle, not three autonomy levels.** Every
  artifact still requires an explicit click to save — nothing here writes to
  the vault or the network without a person choosing to.
- **File transfer for large attachments** isn't wired into the UI yet, though
  `p2p.js` already exposes `sendBlob` for it — Trystero chunks large payloads
  automatically.
- **Research sync** is a simple id-diff on peer join, not incremental CRDT
  merge — good enough for two participants trading artifacts live, not yet
  built for conflict resolution on concurrent edits to the *same* artifact.

## Browser requirements

- WebRTC (all modern browsers).
- IndexedDB (all modern browsers).
- WebGPU for local AI (currently Chrome/Edge on desktop, and progressively
  elsewhere) — the app detects its absence and simply disables the AI
  buttons, everything else keeps working.
