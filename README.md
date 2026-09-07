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
  posting is shown to candidates. **Business** additionally requires a
  professional email on the Offer side; **Independant** requires a
  self-declared LinkedIn URL on the Service side (both real HTML5
  `required` fields).
- **Annonce** — the same Offer/Client mechanic again (Seller/Buyer here),
  built for peer-to-peer sales rather than services: the Seller can attach
  a photo, resized client-side to a small thumbnail and sent as part of
  the discovery broadcast itself, so it shows up the moment a listing is
  discovered — no separate download step.
- **Dating** — no fixed roles. Every identity has both a profile ("about
  me") and a search ("looking for"). A match score is the *minimum* of two
  directions: how well their profile fits what you're looking for, and how
  well your profile fits what they're looking for — a real match needs both
  sides to work, not just one.
- **Intelligence** (internally still the `research` namespace — see below)
  — a build/critic **chain**, not a free-for-all. The
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

### Which namespace you land on

The app remembers the last namespace you had open (stored in IndexedDB's
`cache` store, not just in memory) and reopens there next time. But "nothing
active anywhere" always wins over that remembered preference — a real
shipped bug was creating an identity (which sets the remembered namespace),
then retiring/deleting it: the preference stayed pointed at that now-empty
namespace, so the welcome screen never came back and you'd land on
"Employment — create an identity" instead. Fixed and unit-tested against
that exact sequence — see `pickActiveNamespace` in `state.js`.

### Attachments: real consent, not just P2P delivery

Files go through an actual offer/accept handshake now — `attachment_offer`
→ the recipient sees a banner in the chat with Accept/Decline →
`attachment_accept` → only then do the bytes actually move over the P2P
channel. Declining sends `attachment_decline` and nothing is ever
transferred. This replaces the earlier simplification where a file sent
immediately with no consent step.

### The two topbar switches are real, persisted state now

Both used to be session-only and silently reset on every reload, which
wasn't the intended behavior:

- **Search live** now persists (`cache` store, key `searchLive:<namespace>`
  / `researchConnect`) and **resumes automatically at boot** if it was on
  last time and you still have an active identity there. It's no longer a
  topbar switch either — it's a "Start searching" / "Stop searching"
  button right next to Edit profile / Enrich with local AI, since that's
  where it actually belongs.
- **Local AI enrichment** isn't a separate switch at all anymore. Clicking
  "Enrich with local AI" *is* the control — whatever keywords it produces
  are used in matching from then on, automatically, the same way your
  regular profile keywords are. Having a switch next to a button that did
  the same job from two disconnected places (topbar vs. profile panel) was
  the actual complaint, and it was a fair one. The discovery broadcast is
  consistent with this too now: it sends whatever AI-derived keywords
  exist, the same as local matching uses.
- **Trystero's CDN path was broken** (`dist/trystero-torrent.min.js`
  404s — the package dropped its bundled `dist/` output entirely and now
  ships plain ESM `src/*.js` files with per-strategy subpath exports).
  Fixed by resolving `trystero/torrent` through `esm.run` instead, the
  same jsdelivr ESM endpoint already used for WebLLM, which correctly
  resolves package.json subpath exports where esm.sh's interop doesn't.

### Full backup / restore, not just Research's per-project export

"Export backup" / "Import backup" (bottom of the rail) download or restore
**everything**: every identity's private key material, every profile,
the blocklist, and all Research projects/artifacts — one JSON file. This
is what lets you survive a cleared cache, a new browser, or a new device
without losing continuity of who you are to peers who already know your
identityId (identityId is re-derived from the imported key on the way
back in, so restoring is naturally idempotent — no separate merge logic).

This is a real credential export: the file contains private keys. The
export button shows that warning before downloading; there's no attempt
to soften it, the same way a password manager doesn't soften a master
export. Deliberately **not** included: chat messages and attachments
(would need Blob-to-base64 conversion for every file ever sent, and
losing conversation history on a fresh device is much lower-stakes than
losing your identity) and the `cache` store (session preferences like
last-active namespace, not worth restoring on a different device).

This is separate from Research's own `project.jobber` export
(`research.js`) — that one is for sharing a single project with a
collaborator; this one is for backing up everything you are in this
browser.

### Recovering chat history from whoever's still online

If your local message store is empty for a conversation (cache cleared,
backup restored on a new device) but the other side is still reachable,
you don't need the full backup for that — reconnecting is enough. The
moment a peer identity you've talked to before comes back online (any
message from them proves it — usually their `discovery` broadcast), a
`conversation_sync_request` goes out with the message ids you already
have; they send back whatever you're missing. Text and metadata travel
over the normal JSON channel; attachment bytes can't be JSON-serialized,
so they follow separately over the binary channel tagged with the
original message id, so the recovered record ends up as one entry, not a
duplicate. Same "diff known ids" idea Research already uses for
artifacts, applied to conversations.

Attachments specifically: if a peer already accepted/received a file from
you (or sent one to you), they have the **full file stored locally**, not
just a note that it exists — `onBlob` persists the actual `Blob` into
IndexedDB at accept time. So a resync gets the real bytes back
immediately; there's no separate "request download" step.

Building this exposed a real bug worth being upfront about: each side was
independently minting its own random id for what's logically the same
message (you send one, and the receiver generated a *different* random id
for their copy of it). That meant "diff known ids" could never actually
converge — every reconnect, not just data-loss recovery, would have looked
like the other side was missing everything, and duplicated the whole
conversation. Fixed by generating one canonical id per logical message
(`crypto.randomUUID()` for chat text, the already-shared `offerId` for
attachments) and having both sides store *that* id instead of minting
their own — see `sendChatMessage` and the `attachment_accept` handling in
`message-router.js`.

### Real fixes: Trystero's package split, a lighter local model, and a better enrich flow

- **Trystero deprecation warning, fixed for real.** As of v0.23, Trystero
  split into scoped packages per strategy (`@trystero-p2p/torrent`,
  `@trystero-p2p/nostr`, ...); the old `trystero/<strategy>` subpath is now
  a deprecated compatibility shim. `p2p.js` resolves the real package
  directly now.
- **WebLLM's default model is much smaller.** It went from a 1B-parameter
  chat model down to `SmolLM2-135M-Instruct-q0f32-MLC` (~720MB VRAM vs.
  well over a gigabyte) — the only thing this ever does is turn CPU-
  extracted keywords into a slightly richer list, not open-ended chat, so
  a bigger model was never buying anything except a much higher chance of
  the GPU hitting a "device lost" reset on modest hardware.
- **"Device was lost" is now caught and explained**, not left to crash
  silently: it's a WebGPU driver-level reset, so `llm.js` throws the dead
  engine away and gives a plain-language message instead of surfacing the
  raw browser error. Unit-tested (`friendlyLlmError`).
- **"Enrich with local AI" moved after "Start searching"** in the profile
  panel, shows real progress on the button itself while the model loads
  (not toast spam), turns **green and stays green** once keywords exist
  (`profile.aiTokens.length > 0` — the button's own state doubles as the
  indicator, no separate flag), and — the part that actually matters —
  **rebroadcasts your updated keywords to everyone already connected**
  once enrichment finishes. Before this, an already-open Search Live
  session only picked up profile changes for *future* peers who joined
  after the edit; anyone already in the room kept seeing your old
  keywords until they reconnected.

### A round of real UI and product fixes

- **Enter key in dialogs now submits, not cancels.** The Cancel button had
  no explicit `type`, so it defaulted to `type="submit"` — and since it was
  first in the DOM, the browser activated *it* (not the real submit
  button) when you pressed Enter in a text field. Cancel is now
  `type="button"`, wired manually; only the actual submit button responds
  to Enter.
- **Keyword summary is a count, not a truncated list.** "Your profile"
  now shows "N CPU keywords" / "N AI keywords" instead of the first ten
  chips — the full list was never that useful at a glance anyway.
- **"Research" is now "Intelligence"** everywhere in the UI. The internal
  namespace key stays `research` (storage, migration, message types,
  tests all untouched) — only the label changed, which is the lower-risk
  way to rename something without touching identity/data continuity.
- **Business (Offer) requires a professional email; Independant (Service)
  requires a LinkedIn URL.** Both are real HTML5 `required` fields — the
  browser blocks saving without them. LinkedIn is explicitly labeled
  self-declared: Jobber has no backend and no way to independently verify
  it, and the UI says so rather than implying a check that isn't real.
- **New namespace: Annonce**, peer-to-peer sales with a photo. Built on
  the same asymmetric Offer/Client mechanic Business and Independant
  already use (Seller declares a price, Buyer declares a budget range,
  hard-filtered against each other) rather than inventing a parallel
  system. The photo is resized client-side to a small JPEG thumbnail
  (max 200px, canvas-based) and travels *inside* the discovery broadcast
  itself — no separate "request to download the photo" round trip, it's
  just there the moment a listing is discovered.
- **Sidebar replaced with a top icon bar.** The old identity-list sidebar
  didn't hold up on desktop and was worse on mobile. Mode switching is now
  a row of icons at the top; switching identities within a namespace (when
  you have more than one) is a native `<select>` in the topbar — renders
  as a proper picker on mobile with no custom dropdown code. Storage/
  backup moved into a small `⚙` panel in the status bar instead of a
  permanent sidebar block. "Your profile" is now a collapsible `<details>`,
  and the redundant "Employment — Recruiter" / hint-text header above it
  is gone — the icon bar and topbar already say what mode and role you're in.

### The topbar absorbed what used to be a separate "Your profile" panel

That panel is gone. Its useful bits moved to where they actually belong:

- **Rename and "Edit profile" are one action now** — a single pencil (✎)
  in the topbar, not two disconnected places to change what's really one
  thing (your display name lives in the same form as your category,
  location, rate, etc. now, for every editor).
- **Category and location aren't displayed as standing text anymore** —
  they're only ever a click away, behind that same pencil. Displaying them
  permanently was redundant with editing them.
- **Keyword counts, Search, and Enrich moved into the topbar**, next to
  the identity actions they relate to. Search shows as a full "Search"
  button when idle, and collapses to a compact "■" once live — the mode
  icon's own green dot already tells you it's running, a second "●
  searching" label next to it was redundant.
- **The standalone `#id` pill is gone whenever the identity picker
  (`<select>`) is shown** — the picker already displays "name · #id" per
  option, so showing the id a second time right next to it was pointless.
  It only reappears when there's a single identity and no picker to make
  it redundant with.

### A round of real fixes and two new modes

- **Identity picker fixed the other way round.** Keep the `#id` pill
  (I'd removed it by mistake); it was the picker's *options* repeating
  "name · #id" for every entry that was the actual overload. Options now
  list names only.
- **"Independant" now displays as "Independent"** (correct English
  spelling) — display label only, the internal namespace key is unchanged
  for the same reason "Research" → "Intelligence" didn't touch the key
  either: renaming storage/protocol identifiers is a real compatibility
  break, renaming a label isn't.
- **Keyword extraction is capped for real** (`MAX_KEYWORDS = 60` in
  `matching.js`) — a CV producing 273 "keywords" wasn't a display bug, the
  *stored* token list itself was uncapped, which was diluting Jaccard
  matching with a long tail of one-off words, not just cluttering the UI.
  Also expanded the boilerplate list with common CV filler ("skills",
  "responsible", "using", "team", …) that isn't a stopword but carries
  ~zero discriminative signal — the ATS-style problem the request named
  directly.
- **P2P discovery switched from the "torrent" strategy to "nostr"**, with
  an explicit pinned relay list (`relay.damus.io`, `nos.lol`,
  `relay.nostr.band`, `nostr.wine`, `relay.snort.social`) rather than
  Trystero's defaults. BitTorrent trackers are inconsistently reachable
  from plain browser JS in practice; public Nostr relays over plain
  WebSocket are a more reliable rendezvous layer for this. I can't verify
  this connects in a real browser from here — report back if discovery is
  still silent.
- **Only the demand side can start a conversation, in every two-sided
  namespace** (`canInitiateChat` in `state.js`): Recruiter, Client,
  Utilisateur, Buyer, Passenger — not their counterparts, who are
  discoverable but wait to be reached out to. This is one generic rule
  (roles[1] decides) rather than a namespace-by-namespace special case,
  enforced both in the UI (the button doesn't render) and in
  `conversations.js`'s `requestChat` itself (defense in depth, not just
  hiding a button). Dating and Intelligence are unchanged — Dating already
  requires both sides to independently act, Intelligence has its own
  join/accept model.
- **New namespace: Drive**, peer-to-peer carpooling. Same Offer/Client
  mechanic as Business/Independant/Annonce (Driver declares a price per
  seat, Passenger declares a budget range) — the passenger decides,
  automatically, from the same generic rule above.
- **New namespace: Agent**, an explicit, honest placeholder — not a real
  feature yet. A genuine cross-namespace agent (reading every match and
  every Intelligence graph to propose operations/connections/moves) is
  substantial enough to deserve its own dedicated pass rather than being
  half-built alongside everything else in this one. This just reserves the
  namespace/identity slot for it.

### Near — built for real this time

Opt-in location sharing, a real radius slider, and real distance filtering
against everyone already discovered in other modes:

- **Real coordinates, real permission prompt.** `geo.js` wraps
  `navigator.geolocation.getCurrentPosition` in a Promise — the browser's
  actual permission dialog is what grants coordinates, nothing is
  simulated. Distance is the real haversine great-circle formula,
  unit-tested against known city-to-city distances (Paris–London ≈ 344 km,
  Lausanne–Geneva ≈ 52 km).
- **Location is a device-level fact, not an identity's.** Near has no
  identity of its own — turning location sharing on piggybacks your real
  coordinates onto whichever namespace discovery broadcasts you're already
  sending (via the same `buildDiscoveryPayload` every namespace already
  uses), rather than Near running a separate discovery mechanism. Turning
  it off, or moving the radius slider, immediately rebroadcasts to anyone
  already connected — same reasoning as the AI-enrichment rebroadcast.
- **It only aggregates, it doesn't discover.** Near reads
  `state.discovered` across every other active namespace and filters to
  peers who (a) also opted into sharing their coordinates and (b) fall
  within your radius, sorted by distance. If you haven't started
  "Search" anywhere else, there's nothing to aggregate — the UI says so
  rather than pretending to search on its own.

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

### Retiring an identity is permanent history, not deletion

Clicking "×" (Retire) sets `active: false` on that identity — it stays in
IndexedDB forever as local history, it's never actually deleted. The rail
and topbar only ever show active identities, so a retired one correctly
disappears from the UI immediately. There *was* a real bug here: on reload,
if a namespace had no active identity left, the boot sequence fell back to
"the first identity record" regardless of its active flag, silently
resurrecting a retired identity as if it were current. Fixed — see
`pickActiveIdentityId` in `state.js`, which is now the single place this
decision is made, and is unit-tested specifically against "everything in
this namespace is retired" returning nothing rather than the wrong record.

## Module architecture: why `state.render` / `state.handlers` exist

`app.js` used to be a single ~2100-line file. It worked, but it had become
exactly the kind of "god object" that's easy to make small, silent mistakes
in — I made two of them myself in earlier passes (duplicated closing
braces from a badly-anchored edit) purely because the file was too big to
reliably reason about a single change in isolation.

It's now split by *what changes together*, not by namespace: identity
handling, profile editing, conversations (chat/meetings/documents/
attachments), classic-namespace discovery, and Research are each their own
module. The tricky part of any such split is that these modules
legitimately need to call back into each other — discovery-ui.js needs to
trigger the same message handling that research-ui.js does, and both need
to trigger a re-render.

Rather than have those modules import each other directly (which produces
real circular imports — message-router.js needs research-ui.js's handlers,
but research-ui.js needs message-router.js's dispatcher to pass to the P2P
layer), two small registries live on the shared `state` object:

```js
state.render = { all, workspace, topbar };      // filled in by app.js
state.handlers = { incomingMessage, toggleSearchLive }; // filled in by
                                                          // render.js / message-router.js /
                                                          // discovery-ui.js at their own module load
```

A feature module calls `state.render.workspace()` or
`state.handlers.incomingMessage(...)` instead of importing the file that
defines them. Nobody needs to import "the thing that calls me back", so
the module graph stays a plain tree instead of a circular mess — verified
by dynamically importing the entire graph in Node with DOM/IndexedDB stubs
and confirming every import/export name actually resolves before any UI
code runs.

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
| `js/state.js` | The shared state object, namespace config, and small pure helpers. Everything else imports from here; it imports nothing app-specific itself. Also where `state.render` / `state.handlers` live — see the "Module architecture" section below. |
| `js/ui-kit.js` | Generic, app-agnostic UI primitives (modal dialog, toast). No app-module imports. |
| `js/identity-ui.js` | The identity rail, the topbar, and create/rename/rotate/retire flows. |
| `js/profiles.js` | Profile storage and the three profile editors (generic, Employment's candidate/recruiter split, Business/Independant's supply/demand split). |
| `js/conversations.js` | Blocking, meeting proposals, document requests, persisted identity-keyed chat with an offline outbox, and the attachment offer/accept handshake. |
| `js/discovery-ui.js` | Search Live, the matching cascade, and the results/chat UI for every non-Research namespace. |
| `js/research-ui.js` | The whole Research namespace: chain/mode project creation, the join request/accept flow, artifacts and their graph, progress/activity, and closure. |
| `js/message-router.js` | The single function that decides what an incoming, already-validated protocol message does — routes to conversations.js / research-ui.js. |
| `js/render.js` | Ties the rail, topbar, and the two workspace kinds together — the one place that imports from identity-ui.js, discovery-ui.js, and research-ui.js all at once. |
| `js/app.js` | The entry point: boot sequence, service worker registration, the WebGPU flag, and wiring `state.render` / `state.handlers` before calling `boot()`. About 100 lines — everything else moved out into the files above once the single-file version got large enough that I was making insertion mistakes editing it (duplicated braces, mis-anchored edits) purely from its size. |
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
