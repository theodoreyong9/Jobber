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

## Namespaces and how matching works in each

- **Employment** — two roles, *Candidate* and *Recruiter*, chosen at identity
  creation and **fixed for the life of that identity** (create a new
  identity to switch sides — see the identity model below). No language
  field; instead country + city. A candidate's cover letter is stored but
  **never tokenized or indexed** — it's shared only when the other side
  requests it (see the cover-letter flow below). Keywords for a candidate
  come from a real .docx/.pdf CV upload; for a recruiter, from the job
  posting text they type directly (which *is* indexed, and is shown to
  candidates as-is since job ads are public by nature, unlike CVs).
  Recruiters set a seniority year range, checked against the earliest
  4-digit year found anywhere in the candidate's CV text — a simple,
  transparent proxy for "how long ago did they start". Matching only ever
  happens candidate ↔ recruiter, never candidate ↔ candidate.
- **Business** (formerly "Mission") and **Independant** (formerly
  "Service") now have the same asymmetric mechanic as Employment, adapted
  to money instead of years: the supply side (*Offer* / *Service*) declares
  a single rate; the demand side (*Client* / *Utilisateur*) declares a
  budget range; a hard filter checks the rate falls inside the range, in
  whichever direction applies. The supply side's description text is
  always tokenized directly (no file required), and an optional `.docx`/
  `.pdf`/`.txt` attachment — genuinely optional, unlike Employment's CV —
  adds keywords on top of it rather than replacing it. The demand side's
  request text is public and shown to the supply side, the same way a job
  posting is shown to candidates.
- **Dating** — no fixed roles. Every identity has both a profile ("about
  me") and a search ("looking for"). A match score is the *minimum* of two
  directions: how well their profile fits what you're looking for, and how
  well your profile fits what they're looking for — a real match needs both
  sides to work, not just one.
- **Research** — a build/critic **chain**, not a free-for-all. The
  initiator defines an ordered sequence of modes when creating the project
  (e.g. Build → Critic → Build), and occupies slot 0 themselves. Anyone else
  requests to join — optionally attaching a `.md` describing their agent's
  skill or task, shown to the initiator when they review the request — and
  the initiator accepts **last**: acceptance automatically slots the
  applicant into the next open chain position, nobody picks their own mode.
  A participant's mode gates which artifact types they can add: `build`
  constructs (hypothesis, experiment, result, synthesis, …), `critic`
  evaluates (critique, analysis, decision). There is no ownership split —
  contribution is just the recorded provenance on each artifact (author,
  agent, parents), not a negotiated percentage. When local AI assist is
  used, the participant's declared skill.md is folded into the model's
  system prompt, so it's genuinely informed by an imported task description
  rather than two bare models just texting each other.

Two-sided namespaces ask for a role when you create the identity. **The role
cannot be changed afterward** — each identity is either one side or the
other, permanently; create a second identity if you need to appear as both.
Older local data created before this naming existed is migrated
automatically on first load: `job_candidate` → `employment`, `mission` →
`business`, `service` → `independant`, with a best-guess default role.

### Cover-letter request/offer flow (Employment)

A recruiter viewing a candidate's card can click "Request cover letter",
which sends a real `document_request` message. The candidate sees an
incoming-request banner and must explicitly click "Share" — nothing is sent
automatically. This mirrors the human-in-the-loop principle used everywhere
else in the app (meetings, research publication, etc.).

### Testing matches without a second device

Real discovery needs two actual peers — one browser tab is one WebRTC
identity, so two identities you create in the *same* tab can never discover
each other over the network (this is a property of WebRTC, not a bug).
Every two-sided or reciprocal namespace shows a **"Local test matches"**
panel: it computes the same scoring function directly against any other
complementary-role identity you've created locally, with no network
involved, clearly labeled as a local preview. Use it to sanity-check a
candidate/recruiter pair (or any other role pair) before testing over a
real connection.

### Finding a Research project to join

There's no central directory of projects. When you connect to the research
room, your client broadcasts `research_project_announce` for any of *your
own* projects that still have an open chain slot; peers you're actually
connected to collect these into an "Open projects on the network" list.
Nothing further away than that is discoverable — share an exported
`.jobber` file, or have someone already connected relay the project, if the
initiator isn't someone you're directly peered with.

### Chat: persisted, keyed by identity not by connection

Messages are stored in IndexedDB (`messages` store) and keyed by the other
side's stable identity — not their WebRTC peer id, which is different every
time they reconnect. A "Conversations" panel lists every past chat in a
namespace, including with peers who are currently offline (read-only until
they're back). Sending while offline saves locally and tells you it wasn't
delivered, rather than pretending it went through. File attachments are
stored as real `Blob`s in IndexedDB, not just object URLs, so they survive
a reload too.

### Progress, activity, and closing a project

Every participant's card shows **last active** (relative time) and a count
of their contributions, computed fresh from real artifact authorship and
touched on every artifact creation or validation — visible to everyone in
the project, not just the initiator, so a participant who's gone quiet is
obvious to all. A participant idle for more than `STALLED_THRESHOLD_MS`
(3 days by default, see `research.js`) is flagged `⚠ inactive` — a display
heuristic only, nothing is auto-removed or auto-reassigned.

Only the **initiator** can close a project (`research.closeProject`,
enforced in the data layer, not just the UI). Closing is final in this
build: no further artifacts can be added by anyone, in any mode, and no new
join requests are accepted. The closure — who, and when — is broadcast to
every connected participant immediately and shown as a banner.

## What's been hardened since the last pass

- **Offline messages auto-resend.** A message written while the recipient
  is offline is saved with `delivered: false`. The moment we see any
  message arrive from that identity again — proof they're back — every
  queued message and file to them is sent automatically (`flushOutbox` in
  `app.js`), no manual reopen required. Chat bubbles show a `· queued` tag
  until that happens.
- **Artifact conflicts are merged, not overwritten.** `validatedBy` is a
  grow-only set — two participants validating the same artifact before
  syncing is a union, not a race (`research.mergeArtifact` /
  `unionValidatedBy`, unit-tested). Validations are now actually broadcast
  to peers too — previously `validateArtifact` only ever wrote locally and
  nobody else ever saw it.
- **Newly-created projects announce immediately** if you're already
  connected, instead of only announcing to the *next* peer that joins.
  Worth noting on the "no central directory" limitation: Trystero forms a
  full mesh per room, so everyone connected to the `research` namespace at
  the same time is already directly peered with everyone else there — the
  real constraint isn't "not enough hops", it's that you have to be online
  at the same time as the announcer, which a serverless design can't get
  around without contradicting itself into needing a server.
- **PDF extraction has two independent CDN fallbacks** for the library
  itself (`esm.run`, then jsdelivr's `+esm`) plus both plausible worker
  filenames per resolved version, with a clear error pointing at `.docx`/
  `.txt` if all of them fail. I still can't test this against a real
  browser from this environment — DOCX extraction is genuinely verified
  (a real ZIP is built and read back in a unit test); PDF extraction is
  written defensively but unverified.

## What each module actually does

| File | Real behavior |
|---|---|
| `js/db.js` | IndexedDB wrapper: identities, profiles, cache, conversations, research projects/artifacts. Nothing here is a server call. |
| `js/identity.js` | Generates a real ECDSA P-256 keypair per identity via WebCrypto. The identity id is a SHA-256 hash of the public key. Rotation generates a fresh keypair and marks the old one retired; retirement is local-only (there's no global authority to enforce it network-wide — the UI says so). |
| `js/protocol.js` | The actual wire format (`v`, `type`, `namespace`, `sender`, `messageId`, `timestamp`, `payload`) and validation used by every message before it's trusted. |
| `js/p2p.js` | Real WebRTC data channels via [Trystero](https://github.com/dmotz/trystero) (`torrent` strategy — public BitTorrent trackers are used only so two browsers can find each other's connection info; no app data passes through them). Loads the pre-bundled browser file from jsdelivr **lazily**, so if a CDN or export-shape hiccup ever breaks it, only P2P is disabled — the rest of the app (identity, profiles, Research vault) keeps working. If `https://cdn.jsdelivr.net/npm/trystero/dist/trystero-torrent.min.js` ever 404s or its export shape changes, swap `TRYSTERO_URL` at the top of the file for `https://unpkg.com/trystero/dist/trystero-torrent.min.js` or a pinned version. |
| `js/discovery.js` | The real cascade: namespace/protocol match → hard filters → soft ranking → budget cap, before anything expensive runs. |
| `js/matching.js` | Deterministic local scoring: tokenize → synonym-normalize → Jaccard overlap → penalty for missing required terms. Versioned (`MATCHING_ENGINE_VERSION`), same formula regardless of whether AI enrichment is on. |
| `js/llm.js` | Loads [WebLLM](https://github.com/mlc-ai/web-llm) only if `navigator.gpu` exists, and only when you click "enrich" — never automatically. Runs a small instruction model entirely client-side. Loaded from `esm.run` (jsdelivr's dedicated ESM endpoint — the one WebLLM's own docs use), not esm.sh, which was throwing `createRequire is not defined` in-browser due to a broken CJS-interop shim. |
| `js/extract.js` | Real text extraction from `.docx` (a hand-rolled ZIP central-directory reader + native `DecompressionStream('deflate-raw')` + `DOMParser` on `word/document.xml` — no dependency at all) and `.pdf` (via pdf.js, lazily loaded, worker version-pinned to whatever the main bundle actually resolved to). This is what a candidate's CV keywords are mined from. |
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

- **No precise geolocation.** Distance-based hard filtering is wired but
  nothing populates `distanceKm` yet; add a manual "approximate area" field
  or the Geolocation API if you want it live.
- **Human-in-the-loop is a single toggle, not three autonomy levels.** Every
  artifact still requires an explicit click to save — nothing here writes to
  the vault or the network without a person choosing to.
- **Attachments skip the `attachment_offer`/`attachment_accept` handshake**
  defined in the protocol — files send immediately on the P2P binary channel
  rather than waiting for the recipient to accept first. The message types
  are reserved in `protocol.js` if you want to add that confirmation step.
- **Conflict handling is CRDT-*lite*, not general CRDT.** Artifacts are
  append-only (new UUID every time), so two people adding artifacts
  concurrently never conflict — they just coexist as siblings in the graph.
  The one genuinely mutable field, `validatedBy`, is merged by union
  (`research.mergeArtifact`). Project-level state (chain, participants,
  closure) is single-writer — only the initiator ever changes it — so there
  is nothing to merge there, but that also means it isn't itself
  conflict-resolved if you deliberately ran two initiators for the same
  project id, which the app doesn't construct a path to do.

## Browser requirements

- WebRTC (all modern browsers).
- IndexedDB (all modern browsers).
- WebGPU for local AI (currently Chrome/Edge on desktop, and progressively
  elsewhere) — the app detects its absence and simply disables the AI
  buttons, everything else keeps working.
