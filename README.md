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

## Deploy it (real CI/CD, no server to maintain)

`.github/workflows/deploy.yml` runs on every push to `main`:

1. **test** — runs the real unit suite (`node --test`, 32 tests, zero
   dependencies) over `protocol.js`, `matching.js`, `discovery.js`,
   `research.js`'s graph layout, and the WebCrypto signing primitives
   `identity.js` is built on.
2. **build** — regenerates the PWA icons (`scripts/generate-icons.mjs`, a
   from-scratch PNG encoder, no image library) and checks that every file
   `sw.js` precaches actually exists (`scripts/check-sw-manifest.mjs`), then
   uploads the whole static site as a Pages artifact.
3. **deploy** — publishes it via `actions/deploy-pages`.

To turn this on: push the repo to GitHub, then in **Settings → Pages** set
the source to "GitHub Actions". No other configuration — there's no backend
to provision because there isn't one.

Run the same checks locally before pushing:

```bash
npm test      # node --test
npm run icons # regenerate icons/*.png
npm run check # verify sw.js precache list against disk
```

## What each module actually does

| File | Real behavior |
|---|---|
| `js/db.js` | IndexedDB wrapper: identities, profiles, cache, conversations, research projects/artifacts. Nothing here is a server call. |
| `js/identity.js` | Generates a real ECDSA P-256 keypair per identity via WebCrypto. The identity id is a SHA-256 hash of the public key. Rotation generates a fresh keypair and marks the old one retired; retirement is local-only (there's no global authority to enforce it network-wide — the UI says so). |
| `js/protocol.js` | The actual wire format (`v`, `type`, `namespace`, `sender`, `messageId`, `timestamp`, `payload`) and validation used by every message before it's trusted. |
| `js/p2p.js` | Real WebRTC data channels via [Trystero](https://github.com/dmotz/trystero) (`torrent` strategy — public BitTorrent trackers are used only so two browsers can find each other's connection info; no app data passes through them). Loads the pre-bundled browser file from jsdelivr **lazily**, so if a CDN or export-shape hiccup ever breaks it, only P2P is disabled — the rest of the app (identity, profiles, Research vault) keeps working. If `https://cdn.jsdelivr.net/npm/trystero/dist/trystero-torrent.min.js` ever 404s or its export shape changes, swap `TRYSTERO_URL` at the top of the file for `https://unpkg.com/trystero/dist/trystero-torrent.min.js` or a pinned version. |
| `js/discovery.js` | The real cascade: namespace/protocol match → hard filters → soft ranking → budget cap, before anything expensive runs. |
| `js/matching.js` | Deterministic local scoring: tokenize → synonym-normalize → Jaccard overlap → penalty for missing required terms. Versioned (`MATCHING_ENGINE_VERSION`), same formula regardless of whether AI enrichment is on. |
| `js/llm.js` | Loads [WebLLM](https://github.com/mlc-ai/web-llm) only if `navigator.gpu` exists, and only when you click "enrich" — never automatically. Runs a small instruction model entirely client-side. |
| `js/research.js` | Research Vault: projects, typed artifacts (`hypothesis`, `critique`, `experiment`, `result`, …), parent/child provenance, export to a `project.jobber` JSON bundle, import back in. |
| `js/app.js` | Wires all of the above to the UI: identity switcher, profile editor, live discovery + ranked matches, P2P chat with file attachments, meeting proposals, a local blocklist, and the Research graph/feed/contract panel. |
| `scripts/generate-icons.mjs` | Hand-encodes real PNGs (IHDR/IDAT/IEND, CRC32, zlib via `node:zlib`) — no canvas dependency. |
| `test/*.test.js` | Real assertions via Node's built-in `node:test` runner — no test framework dependency. |

## Since the last pass, these are now real too

- **Blocklist** (`js/db.js`'s `blocklist` store) — blocking a peer is keyed by
  their signed identity, not their ephemeral WebRTC peer id, persists across
  reconnects, and silently drops their messages at `handleIncomingMessage`.
  It's explicitly local-only — the UI doesn't claim otherwise.
- **File attachments** in chat — real `Blob` transfer over Trystero's binary
  action channel (it chunks large payloads itself); received files become a
  download link in the chat log.
- **Meeting proposals** — `meeting_proposal` / `meeting_accept` /
  `meeting_decline` are wired end-to-end with a small UI banner on the
  result card.
- **Discovery expiry** (spec §101) — discovered peers older than 10 minutes
  drop out of the ranked results automatically; a 30s interval re-renders
  while any namespace is searching so this actually happens without user
  action.
- **CI/CD and GitHub Pages** — see the section above.
- **Real PWA icons** — no more inline SVG placeholder; 192px and 512px PNGs
  generated from scratch.

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
- **Attachments skip the `attachment_offer`/`attachment_accept` handshake**
  defined in the protocol — files send immediately on the P2P binary channel
  rather than waiting for the recipient to accept first. The message types
  are reserved in `protocol.js` if you want to add that confirmation step.
- **Research sync** is a simple id-diff on peer join, not incremental CRDT
  merge — good enough for two participants trading artifacts live, not yet
  built for conflict resolution on concurrent edits to the *same* artifact.

## Browser requirements

- WebRTC (all modern browsers).
- IndexedDB (all modern browsers).
- WebGPU for local AI (currently Chrome/Edge on desktop, and progressively
  elsewhere) — the app detects its absence and simply disables the AI
  buttons, everything else keeps working.
