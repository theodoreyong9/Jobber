# Jobber — Personal Interoperable Agency

A local-first, peer-to-peer web app. No backend, no central database, no
build step: plain HTML, CSS, and ES modules.

Identity is an ECDSA keypair generated in the browser (WebCrypto). Storage
is IndexedDB. Networking is WebRTC via Trystero. Matching is a
deterministic local scoring algorithm. Local AI enrichment, when the
device supports it, is a WebLLM model running in-browser. Research
artifacts are records with parent/child provenance, exportable as a file.
Nothing here calls out to a server Jobber controls.

## Run it

Browsers block ES module imports and service workers on the bare `file://`
protocol, so serve the folder over HTTP:

```bash
npx serve .
# or: python3 -m http.server 8080
```

Open the printed local URL in **two separate browser tabs, windows, or
devices** — Jobber talks to itself over real peer-to-peer connections, so
a single tab alone never discovers a peer.

## Deploy it

`.github/workflows/deploy.yml` runs on every push to `main`:

1. **test** — `node --test` (`test/*.test.js`, no dependencies) over
   `protocol.js`, `matching.js`, `discovery.js`, `research.js`'s graph
   layout, `identity.js`'s WebCrypto primitives, `agent.js`,
   `trust-dag.js`/`credibility.js`'s scoring formula, `backup.js`, `geo.js`,
   `extract.js`, and `llm.js`'s error handling.
2. **build** — regenerates the PWA icons (`scripts/generate-icons.mjs`, a
   from-scratch PNG encoder, no image library) and checks that every file
   `sw.js` precaches actually exists (`scripts/check-sw-manifest.mjs`), then
   uploads the static site as a Pages artifact.
3. **deploy** — publishes it via `actions/deploy-pages`.

To turn this on: push the repo to GitHub, then in **Settings → Pages** set
the source to "GitHub Actions". No other configuration.

Run the same checks locally:

```bash
npm test      # node --test
npm run icons # regenerate icons/*.png
npm run check # verify sw.js precache list against disk
```

## Identity model

An identity is a namespace, a display name, an ECDSA P-256 keypair, and
(for two-sided namespaces) a role. The identity id is a SHA-256 hash of
the public key.

- **A role is fixed for the life of an identity.** Two-sided namespaces
  ask for a role at creation; switching sides means creating a second
  identity.
- **One active identity per role, per namespace** (`takenRoles` in
  `identity-ui.js`). The role picker only offers roles with no active
  identity yet; creating one for a full namespace is blocked with a toast.
  Retiring an identity frees its role back up.
- **Retiring is not deleting.** Clicking "×" sets `active: false`; the
  record stays in IndexedDB as local history. Rails/topbar only show
  active identities. `pickActiveIdentityId` (`state.js`) is the single
  place that decides which identity a namespace lands on, and returns
  nothing (not a retired record) when every identity in a namespace is
  retired.
- **Rotation** generates a fresh keypair, marks the old one retired, and
  links `rotatedTo` — products (see below) and the observer's own
  credibility history for that identity (`credibility.handleRotation`)
  carry forward onto the new id instead of resetting.
- **A browser-wide identity cap** limits how many active identities can
  exist across every namespace at once (`credibility.identityCapFor`,
  enforced in `identity-ui.js`'s `createIdentityFlow`): `BASE_IDENTITY_CAP`
  (10) plus `IDENTITY_PALIER_STEP` (10) for each threshold in
  `IDENTITY_PALIERS` (currently `[50]`) that this browser's aggregate
  Credibility score (below) has cleared. Hitting the cap blocks creation
  with an explanatory toast rather than silently failing.

## Namespaces and how matching works in each

- **Employment** — roles *Candidate* / *Recruiter*. Country + city instead
  of a language field. A candidate's cover letter is stored but never
  tokenized or indexed — shared only when the other side explicitly
  requests it (see Cover-letter flow below). Candidate keywords come from
  an uploaded `.docx`/`.pdf` CV; recruiter keywords come from job-posting
  text typed directly, which is indexed and shown to candidates as-is.
  Recruiters set a seniority year range, checked against the earliest
  4-digit year found in the candidate's CV text. Matching only ever runs
  candidate ↔ recruiter.
- **Business** — roles *Offer* / *Client*, the same asymmetric mechanic as
  Employment adapted to money: Offer declares a single rate, Client
  declares a budget range, a hard filter checks the rate falls inside it.
  Offer's description text is always tokenized directly; an optional
  `.docx`/`.pdf`/`.txt` attachment adds keywords on top of it. Client's
  request text is shown to Offer as-is. Offer requires a professional
  email (HTML5 `required`).
- **Outdoor** — roles *Organizer* / *Participant*, the two-sided mechanic
  with no price axis. Organizer posts a freely-chosen activity theme with
  a contact method (email/phone/other) and a declared (not enforced)
  participant headcount. Participant is matched by keyword overlap alone.
- **Dating** — no fixed roles. Every identity has a profile ("about me")
  and a search ("looking for"). The match score is the *minimum* of both
  directions — how well their profile fits your search, and yours fits
  theirs — so a real match needs both sides to work.
- **Intelligence** (internal namespace key: `research`) — a build/critic
  **chain**, not a free-for-all. The initiator defines an ordered sequence
  of modes at project creation (e.g. Build → Critic → Build) and occupies
  slot 0. Anyone else requests to join — optionally attaching a `.md`
  describing their agent's skill or task — and the initiator accepts
  requests **in order**, each acceptance slotting the applicant into the
  next open chain position; nobody picks their own mode. A participant's
  mode gates which artifact types they can add: `build` constructs
  (hypothesis, experiment, result, synthesis, …), `critic` evaluates
  (critique, analysis, decision). Contribution is recorded provenance
  (author, agent, parents) on each artifact, not a negotiated ownership
  split. When local AI assist is used, a participant's declared skill.md
  is folded into the model's system prompt.

Older on-disk namespace keys are migrated automatically on first load:
`job_candidate` → `employment`, `mission` → `business`.

### Cover-letter request/offer flow (Employment)

A recruiter viewing a candidate's card clicks "Request cover letter",
sending a `document_request`. The candidate sees an incoming-request
banner and must explicitly click "Share" — nothing is sent automatically.

### Testing matches without a second device

Real discovery needs two actual peers — a single browser tab is one
WebRTC identity, so identities created in the same tab never discover
each other over the network (see "Every identity in a namespace can be
live at once" below for exactly why). Every two-sided or reciprocal
namespace still scores any other complementary-role identity you've
created locally exactly the way it scores a real peer, and shows it in
the **same results list**, with no visual separation. Blocking, chatting,
and every other card action work the same on a local match, except that
there's no live peer connection behind it, so messaging one hits the same
"not currently connected" path a real peer who went offline would.

### Finding a Research project to join

There is no central directory of projects. Connecting to the `research`
room broadcasts `research_project_announce` for any of your own projects
that still have an open chain slot; peers you're directly connected to
collect these into an "Open projects on the network" list. Nothing
further away is discoverable — share an exported `.jobber` file, or have
someone already connected relay the project.

### Chat: persisted, keyed by identity not by connection

Messages live in IndexedDB (`messages` store), keyed by the other side's
stable identity — not their WebRTC peer id, which changes on every
reconnect. A "Conversations" panel lists every past chat in a namespace,
including with peers currently offline (read-only until they're back).
Sending while offline saves locally and reports it as undelivered rather
than pretending it went through. File attachments are stored as real
`Blob`s in IndexedDB, not object URLs, so they survive a reload.

### Progress, activity, and closing a Research project

Every participant's card shows last-active (relative time) and a
contribution count, computed from real artifact authorship and refreshed
on every artifact creation or validation, visible to every participant.
One idle past `STALLED_THRESHOLD_MS` (3 days, `research.js`) is flagged
`⚠ inactive` — a display heuristic only, nothing is auto-removed or
auto-reassigned.

Only the **initiator** can close a project (`research.closeProject`,
enforced in the data layer). Closing is final: no further artifacts from
anyone, in any mode, and no new join requests. The closure is broadcast to
every connected participant immediately.

### Which namespace you land on

The app remembers the last namespace you had open (IndexedDB's `cache`
store) and reopens there. "Nothing active anywhere" always wins over that
remembered preference — see `pickActiveNamespace` in `state.js`.

### Attachments: consent, not just delivery

Files go through an offer/accept handshake: `attachment_offer` → the
recipient sees a banner with Accept/Decline → `attachment_accept` → only
then do the bytes move over the P2P channel. Declining sends
`attachment_decline` and nothing is transferred.

### Search Live and local AI enrichment

- **Search Live** persists (`cache` store, key `searchLive:<namespace>` /
  `researchConnect`) and resumes automatically at boot if it was on last
  time and the identity is still active. It's a "Start searching" / "Stop
  searching" button next to Edit profile / Enrich with local AI.
- **"Enrich with local AI"** is not a separate toggle — clicking it *is*
  the control. Whatever keywords it produces are used in matching from
  then on, and are rebroadcast immediately to anyone already connected
  (`profile.aiTokens.length > 0` doubles as the button's own "already
  enriched" state).

### Full backup / restore

"Export backup" / "Import backup" (bottom of the rail) download or
restore **everything**: every identity's private key material (including
its `products` list), every profile, the blocklist, and all Research
projects/artifacts — one JSON file. identityId is re-derived from the
imported key on the way back in, so restoring is idempotent with no
separate merge logic.

This is a real credential export — the file contains private keys, and
the export button says so before downloading. Deliberately **not**
included: chat messages and attachments (would need Blob-to-base64
conversion for every file ever sent) and the `cache` store (session
preferences, not worth restoring on a different device).

This is separate from Research's own `project.jobber` export
(`research.js`), which shares a single project with a collaborator.

### Recovering chat history from whoever's still online

If the local message store is empty for a conversation (cache cleared,
backup restored on a new device) but the other side is reachable,
reconnecting is enough — the full backup isn't needed for this. The
moment a peer you've talked to before comes back online, a
`conversation_sync_request` goes out with the message ids already held;
they send back whatever's missing. Text/metadata travel over the JSON
channel; attachment bytes follow separately over the binary channel,
tagged with the original message id, so the recovered record lands as one
entry, not a duplicate. Each logical message has one canonical id
(`crypto.randomUUID()` for chat text, the shared `offerId` for
attachments) rather than each side minting its own, which is what lets
"diff known ids" actually converge. If a peer already accepted/received a
file, they hold the full `Blob` locally (`onBlob` persists it at accept
time), so a resync recovers real bytes immediately.

### Only the demand side can start a conversation

In every two-sided namespace, only Recruiter, Client, Utilisateur, Buyer,
etc. — not their counterparts — can initiate a chat (`canInitiateChat` in
`state.js`, one generic rule: `roles[1]` decides). The counterpart is
discoverable but waits to be reached out to. Enforced both in the UI (the
button doesn't render) and in `conversations.js`'s `requestChat` itself.
Dating and Intelligence are unaffected — Dating requires both sides to act
independently, Intelligence has its own join/accept model.

## Cross-namespace tools

These have no identity or profile of their own — they only read what the
Match namespaces above have already discovered or produced.

- **Near** (`near-ui.js`) — opt-in location sharing. `geo.js` wraps the
  real `navigator.geolocation` permission prompt in a Promise; distance is
  the haversine great-circle formula. Location is a device-level fact, not
  an identity's — turning it on piggybacks real coordinates onto whichever
  namespace's discovery broadcast is already going out
  (`buildDiscoveryPayload`), rather than running a separate discovery
  mechanism. Near only aggregates `state.discovered` across every other
  active namespace, filtered to peers who also opted in and fall within
  the radius slider — it doesn't discover anyone on its own, and says so
  if nothing else is searching yet.
- **Agent** (`agent.js` / `agent-ui.js`) — a cross-namespace opportunity
  matcher: among everyone already discovered anywhere, does anyone need
  what you offer, or offer what you search for, in some *other*
  namespace? Every finding states whether it needed AI-enriched keywords
  or was reachable from CPU keywords alone (`usedAi`). `tokens` and
  `aiTokens` travel as separate fields on the discovery wire specifically
  so this distinction survives.
- **Messages** (`messages-ui.js`) — every pending chat/meeting/document/
  attachment request and every ongoing conversation, gathered from every
  mode's own state into one inbox. It doesn't reimplement the chat panel:
  "Open" jumps into that namespace's own workspace, where the existing
  chat UI (offline queueing, attachments, resync) already runs.

## The Bureau — one home screen for every identity

The app opens onto the Bureau (`desktop-ui.js`), not straight into a
namespace: every identity across every namespace as one tile, tap to open
its workspace. Tapping "+" picks which mode the new identity is for
first, then names it.

Tool/link tiles are grouped by `NAMESPACE_GROUPS` (`state.js`):

- **Match** — Employment, Business, Outdoor, Dating.
- **Insight** — Intelligence, Near, Agent, Messages.
- **Ecosystem** — external links that open another app in this portfolio
  in a new tab: Creator → YourMine, Wallet → AIWA, Tribute → SGD. No
  identity, no profile, the tile just navigates.
- **About** — Pricing, a static in-app page (see below).

Tools not fully built yet (Creator, Wallet, Agent, Pricing's own
non-Free tiers) carry an amber "cooking" badge, distinct from Messages'
red notification-count badge.

## Products and Pricing

There is no account, so "owning" a product means every identity in this
browser carries its own `products` list (`identity.js`), and `products.js`
keeps every identity's list in sync with the union of whatever any of
them has ever been attached — attach via one identity, it propagates to
every other identity in this browser, and back. Cumulative and idempotent
(a Set union). Storing it on the identity record, not a separate
browser-wide key, is what makes it survive backup/restore and carry
forward through rotation.

`free` is attached automatically the first time any identity is ever
created (`attachProduct('free')` in `identity-ui.js`), the same call path
any future purchase would use — there's no special case for it. The other
four products (`PRODUCTS` in `products.js`) are defined and attachable
through the same function, but have no checkout flow wired up yet:
**Gossip** (peers relay/hold messages while you're offline, ~$1/mo),
**AIWA** (chain-anchored persistence via the AIWA_chain project, ~$2/mo),
**Booster AI** (a bigger cloud-hosted enrichment model, ~$3/mo), **Agent
Booster** (deeper cross-namespace matching, ~$4/mo). The Pricing page
(`pricing-ui.js`) renders all five as disabled buttons with a real/"Soon"
status pill and an indicative price.

`hasProduct()` is a local UI signal only, never a security boundary: any
code running in this browser (including devtools) can call
`attachProduct()` directly. That's fine for Free; it matters for the
other four, each of which would spend a real resource belonging to
someone else — real enforcement, when built, has to live wherever that
resource is actually spent (the relay peer, the chain, the cloud model),
not in this file.

## Credibility

Every result card shows two independent numbers: **Match** (does the
profile fit — `matching.js`'s deterministic score) and **Credibility**
(`credibility.js` — what has this browser actually seen this identity
do).

Credibility is **not** a global reputation number Jobber computes and
broadcasts. Each observer builds their own append-only, content-addressed
event log (`trust-dag.js`'s `EventDag`, ported from
[AIWA_chain](https://github.com/theodoreyong9/AIWA_chain)'s
`event-dag.js`) from what they've personally witnessed about one peer,
and scores it locally — nobody else's number for that same peer has to
agree with yours.

No account or payment is involved. Sybil resistance comes from requiring
**distinct kinds** of real, two-way interaction the protocol itself
proves happened: a chat accepted, a meeting confirmed, a document shared,
an attachment completed. Each type scores with diminishing returns per
type, so repeating one interaction kind can't substitute for diversity of
kinds. `recordEvent` is idempotent (a `dedupeKey` per interaction), and
rotating an identity re-keys the observer's accumulated history onto the
new id (`handleRotation`) instead of resetting it.

Separately, `computeGlobalCredibility()` rolls up every credibility event
this browser has ever recorded, across every namespace and counterpart,
into one aggregate score — not "how much everyone trusts me" (nothing
here could ask that), but "how much real P2P history has this browser
itself built up". That aggregate is what `identityCapFor` reads to gate
how many identities this browser is allowed to hold at once (see Identity
model above) — same-tab identities can never inflate it against each
other, since Trystero gives one browser tab exactly one real peer id, so
two of your own identities can never become genuine peers of one another.

## Every identity in a namespace can be live at once

`searchLive[ns]` is a `Set` of identityIds, not a single per-namespace
flag — every identity in a namespace can independently be searching.
Everything that needs to distinguish identities within a namespace (chat
log, pending chats/meetings/documents/attachment-offers, open chat,
loaded conversations) is bucketed by identityId. `activeIdentityId[ns]`
means only "which one am I currently *viewing*", entirely decoupled from
which ones are live.

The room itself is still one join per namespace, shared by every live
identity in it: Trystero mints exactly one `selfId` per browser tab,
shared by every room that tab joins, and joining the same room id twice
returns the same room object rather than a second connection — so the
room can't be sharded per identity even if that were otherwise desirable
(and it isn't: the room id can't depend on identityId, or two strangers
couldn't find each other without already knowing each other's identityId).
Multiple live identities in the same namespace share that one connection,
each broadcasting its own `discovery` message under its own `sender`.

One structural consequence: **two of your own identities in the same
browser tab can never become real WebRTC peers of each other** — they're
the same peer to Trystero. That's what "Testing matches without a second
device" (above) exists for.

Sharing one connection means a peer who's discovered two of your
identities needs a way to say which one a cold-start message (a chat
request, a meeting proposal, a document request, a file offer) is for —
`sender` on that message is *their* identity, not yours. `protocol.js`
carries a `targetIdentityId` field for this, resolved on the receiving
end by `state.js`'s `resolveLiveIdentity` (with a fallback for a message
that predates the field), stamped by every outgoing send in
`conversations.js`.

## Module architecture

The app is split by *what changes together*, not by namespace: identity
handling, profile editing, conversations (chat/meetings/documents/
attachments), classic-namespace discovery, and Research are each their
own module. These modules legitimately need to call back into each other
— discovery-ui.js needs to trigger the same message handling
research-ui.js does, and both need to trigger a re-render — without
importing each other directly, which would produce real circular imports
(message-router.js needs research-ui.js's handlers, but research-ui.js
needs message-router.js's dispatcher to pass to the P2P layer).

Two small registries on the shared `state` object solve this:

```js
state.render = { all, workspace, topbar };      // filled in by app.js
state.handlers = { incomingMessage, toggleSearchLive, rebroadcastDiscovery };
// filled in by render.js / message-router.js / discovery-ui.js at their own module load
```

A feature module calls `state.render.workspace()` or
`state.handlers.incomingMessage(...)` instead of importing the file that
defines them, so the module graph stays a plain tree. This is verified by
dynamically importing the entire graph in Node with DOM/IndexedDB stubs
and confirming every import/export name actually resolves before any UI
code runs.

## What each module does

| File | Role |
|---|---|
| `js/db.js` | IndexedDB wrapper: identities, profiles, cache, conversations, blocklist, research projects/artifacts, credibility events. |
| `js/identity.js` | ECDSA P-256 keypair per identity via WebCrypto; identityId is a SHA-256 hash of the public key. Create/list/rename/rotate/retire/delete, and the `products` field each identity carries (see products.js). |
| `js/protocol.js` | The wire format (`v`, `type`, `namespace`, `sender`, `messageId`, `timestamp`, `payload`, optional `correlationId`/`targetIdentityId`) and validation for every message before it's trusted. |
| `js/p2p.js` | WebRTC data channels via [Trystero](https://github.com/dmotz/trystero)'s `nostr` strategy (a pinned list of public Nostr relays over plain WebSocket, used only as a rendezvous layer — no app data passes through them), loaded lazily from `esm.run` so a CDN or export-shape break disables only P2P, not the rest of the app. One room join per namespace, shared by every live identity there. |
| `js/geo.js` | Wraps `navigator.geolocation` in a Promise, plus the haversine distance formula Near filters by. |
| `js/discovery.js` | The matching cascade: namespace/protocol match → hard filters → soft ranking → budget cap. |
| `js/matching.js` | Deterministic local scoring: tokenize → synonym-normalize → Jaccard overlap → penalty for missing required terms. Versioned (`MATCHING_ENGINE_VERSION`). |
| `js/llm.js` | Loads [WebLLM](https://github.com/mlc-ai/web-llm) only if `navigator.gpu` exists and only on explicit click; runs a small instruction model entirely client-side; catches WebGPU "device lost" resets with a plain-language message. |
| `js/extract.js` | Text extraction from `.docx` (hand-rolled ZIP reader + `DecompressionStream('deflate-raw')` + `DOMParser`, no dependency) and `.pdf` (pdf.js, lazily loaded). |
| `js/research.js` | Research Vault: projects, typed artifacts, parent/child provenance, export/import as `project.jobber`. |
| `js/agent.js` | The cross-namespace opportunity matcher (see Cross-namespace tools above). |
| `js/state.js` | Shared state object, namespace config (`NS_CONFIG`, `NAMESPACE_GROUPS`), and pure helpers (`ensureIdentityState`/`migrateIdentityState`/`resolveLiveIdentity`/`canInitiateChat`/`pickActiveIdentityId`). Hosts `state.render`/`state.handlers`. Imports nothing app-specific. |
| `js/ui-kit.js` | Generic UI primitives (modal dialog, toast). No app-module imports. |
| `js/identity-ui.js` | The topbar (identity picker, edit-profile pencil, Search/Enrich controls) and create/rename/rotate/retire flows, including the identity cap and one-active-identity-per-role rule. |
| `js/profiles.js` | Profile storage and the profile editors: generic, Employment's candidate/recruiter split, Business's supply/demand split, Outdoor's organizer/participant split. Every editor shares a display-name field and a YourMine URL field. |
| `js/conversations.js` | Blocking, meeting proposals, document requests, persisted identity-keyed chat with an offline outbox, and the attachment offer/accept handshake. Also the outgoing side of every credibility-recording hook. |
| `js/discovery-ui.js` | Search Live, the matching cascade, and the results/chat UI for every non-Research namespace. Renders Match and Credibility on every card. |
| `js/research-ui.js` | The whole Research namespace: chain/mode project creation, join request/accept, artifacts and their graph, progress/activity, closure. |
| `js/message-router.js` | Decides what an incoming, already-validated protocol message does — routes to conversations.js / research-ui.js, and records the incoming side of every credibility event. |
| `js/trust-dag.js` | A content-addressed, grow-only event DAG and weighted-median aggregator, ported from AIWA_chain's `event-dag.js`/`weighted-median.js`. No app logic. |
| `js/credibility.js` | Per-peer Credibility scoring, the global aggregate score, and the identity cap it gates (see Credibility above). |
| `js/products.js` | The product-attach system behind Pricing: syncs every identity's `products` list to the union across all of them (see Products and Pricing above). |
| `js/pricing-ui.js` | Renders the Pricing page from `products.js`'s product list and attach state. |
| `js/desktop-ui.js` | The Bureau: every identity as a tile, tool/link tiles grouped by `NAMESPACE_GROUPS`, mode-first identity creation. |
| `js/near-ui.js` | Near's workspace. |
| `js/agent-ui.js` | Renders what `agent.js` finds. |
| `js/messages-ui.js` | The centralized inbox (see Cross-namespace tools above). |
| `js/backup.js` | Full-account export/import as one JSON file (see Full backup / restore above). |
| `js/render.js` | Ties the rail, topbar, and every workspace kind together — the one place importing from identity-ui.js, discovery-ui.js, research-ui.js, near-ui.js, agent-ui.js, messages-ui.js, pricing-ui.js, and desktop-ui.js at once. |
| `js/app.js` | Entry point: boot sequence, service worker registration, the WebGPU flag, wiring `state.render`/`state.handlers` before calling `boot()`. |
| `scripts/generate-icons.mjs` | Hand-encodes PNGs (IHDR/IDAT/IEND, CRC32, zlib via `node:zlib`) — no canvas dependency. |
| `test/*.test.js` | Assertions via Node's built-in `node:test` runner — no test framework dependency. |

## Deliberate simplifications

- **No precise geolocation-based hard filtering.** Distance is computed
  and Near sorts/filters by it, but nothing else in the app treats
  distance as a required constraint.
- **Human-in-the-loop is a single toggle, not autonomy levels.** Every
  Research artifact requires an explicit click to save — nothing writes
  to the vault or the network without a person choosing to.
- **Conflict handling is CRDT-*lite*, not general CRDT.** Artifacts are
  append-only (new UUID every time), so concurrent additions never
  conflict — they coexist as siblings in the graph. The one mutable
  field, `validatedBy`, merges by union (`research.mergeArtifact`).
  Project-level state (chain, participants, closure) is single-writer —
  only the initiator changes it — so there's nothing to merge there, but
  that also means two initiators deliberately sharing one project id
  would not be conflict-resolved; the app has no path that constructs
  that situation.
- **Product enforcement is UI-only** (see Products and Pricing above) —
  `hasProduct()` cannot be a security boundary against the browser it
  runs in.

## Browser requirements

- WebRTC (all modern browsers).
- IndexedDB (all modern browsers).
- WebGPU for local AI (currently Chrome/Edge on desktop, progressively
  elsewhere) — the app detects its absence and disables the AI buttons;
  everything else keeps working.
