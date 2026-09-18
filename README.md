# Jobber — Personal Interoperable Agency

A local-first, peer-to-peer web app. No backend, no central database, no
build step: plain HTML, CSS, and ES modules. Identity is an ECDSA keypair
generated in the browser; storage is IndexedDB; networking is WebRTC via
Trystero; matching is a deterministic local scoring algorithm; local AI
enrichment (when the device supports WebGPU) runs a WebLLM model
in-browser. Nothing here calls out to a server Jobber controls.

## Run it

```bash
npx serve .
# or: python3 -m http.server 8080
```

Open the printed URL in **two separate tabs, windows, or devices** —
discovery is real peer-to-peer, so one tab alone never finds a peer.

## Deploy it

Push to GitHub, then in **Settings → Pages** set the source to "GitHub
Actions". `.github/workflows/deploy.yml` runs `node --test`, regenerates
PWA icons, checks the service-worker precache list against disk, and
publishes via `actions/deploy-pages` on every push to `main`.

```bash
npm test      # node --test
npm run icons # regenerate icons/*.png
npm run check # verify sw.js precache list against disk
```

## What's in it

**Match namespaces** — each pairs two roles and scores them by keyword
overlap (`matching.js`):

| Namespace | Roles | What's distinct about it |
|---|---|---|
| Employment | Candidate / Recruiter | CV upload vs. job-posting text; seniority-year hard filter; cover letter shared only on explicit request |
| Business | Offer / Client | Rate vs. budget-range hard filter |
| Outdoor | Organizer / Participant | Activity + contact info, no price axis |
| Dating | none (symmetric) | Match score is the *minimum* of both directions — both sides have to fit |
| Info | Source / Seeker | Plain keyword overlap, no hard filter — the baseline every namespace builds on |

**Intelligence** (`research`) — agent-to-agent collaboration on a defined
build/critic chain: the initiator sets the mode sequence, others request
to join in order, contribution is provenance (author, parents) on each
artifact rather than negotiated ownership.

**Cross-namespace tools** — no identity of their own, they only read what
the namespaces above have already discovered:
- **Near** — opt-in location, aggregates already-discovered peers within a
  radius. A separate "Your identities" panel shows which of your own
  identities are currently live/advertising there.
- **Agent** — cross-references what you offer/search against everyone
  already discovered, across namespaces, flagging whether a match needed
  AI-enriched keywords.
- **Messages** — one inbox for every pending request and conversation
  across every mode, with unread counts, favorites, and keyword search.

**The Bureau** (`desktop-ui.js`) is the home screen: every identity you've
created, across every namespace, as one tile. YourMine, AIWA, and Tribute
are external-link tiles into the rest of this portfolio (SGD, AIWA_chain).

**Pricing** — Free is live and attached automatically on first identity.
Four paid tiers (Gossip relay, AIWA chain-anchored persistence, Booster
AI, Agent Booster) are defined and shown on the Pricing page but have no
checkout wired up yet.

## Identity & trust

- A keypair per identity; the id is a SHA-256 hash of the public key. A
  role is fixed for its life — switching sides means a new identity.
- **Rotate** replaces the keypair, keeps the name and profile, and
  broadcasts `identity_retired` for the old id — connected peers stop
  accepting anything from it. **Retire** (×) does the same without a
  successor: the old id is gone for good, network-wide, not just hidden
  locally.
- More than one identity per namespace can be live (searching) at once;
  they share one P2P room per namespace.
- A browser-wide cap limits total active identities, raised by
  **Credibility** — a per-observer, local trust score built from real,
  distinct two-way interactions (chat accepted, meeting confirmed,
  document shared, attachment completed), never a number Jobber computes
  centrally or broadcasts. Match (does the profile fit) and Credibility
  (has this browser seen this identity follow through) are shown
  separately on every card and never combined.

## Architecture

Feature modules (identity, profiles, conversations, discovery, research)
call back into each other through two registries on the shared `state`
object — `state.render` and `state.handlers` — instead of importing each
other directly, keeping the module graph a tree instead of a cycle.

| File | Role |
|---|---|
| `js/db.js` | IndexedDB wrapper for every store. |
| `js/identity.js` | Keypair generation; create/list/rename/rotate/retire/delete. |
| `js/protocol.js` | Wire format and message validation. |
| `js/p2p.js` | WebRTC via Trystero (nostr relays as rendezvous only), one room per namespace. |
| `js/geo.js` | Geolocation promise wrapper + haversine distance. |
| `js/discovery.js` | Matching cascade: protocol match → hard filters → soft ranking. |
| `js/matching.js` | Deterministic keyword-overlap scoring. |
| `js/llm.js` | Lazy, click-gated WebLLM loading for local AI enrichment. |
| `js/extract.js` | Text extraction from `.docx`/`.pdf`, no dependency. |
| `js/research.js` | Research Vault: projects, artifacts, provenance, export/import. |
| `js/agent.js` | Cross-namespace opportunity matcher. |
| `js/state.js` | Shared state, namespace config, the render/handlers registries. |
| `js/identity-ui.js` | Topbar, identity actions, Search Live / Enrich controls. |
| `js/profiles.js` | Profile storage and editors per namespace. |
| `js/conversations.js` | Chat, meetings, documents, attachments, offline outbox. |
| `js/discovery-ui.js` | Search Live, results list, Match + Credibility display. |
| `js/research-ui.js` | The whole Intelligence namespace UI. |
| `js/message-router.js` | Routes incoming P2P messages; records credibility events. |
| `js/trust-dag.js` | Content-addressed event DAG behind Credibility. |
| `js/credibility.js` | Per-peer and global credibility scoring; the identity cap. |
| `js/products.js` / `js/pricing-ui.js` | Product-attach system and the Pricing page. |
| `js/desktop-ui.js` | The Bureau. |
| `js/near-ui.js` / `js/agent-ui.js` / `js/messages-ui.js` | The three cross-namespace tools. |
| `js/marks.js` | Seen/favorite flags reused across result lists and Messages. |
| `js/backup.js` | Full-account export/import as one JSON file. |
| `js/render.js` | Ties rail, topbar, and every workspace together. |
| `js/app.js` | Entry point and boot sequence. |
| `test/*.test.js` | `node --test`, no framework dependency. |

## Known limits

- No hard geolocation filter — Near sorts/filters by distance, nothing
  else treats it as a required constraint.
- Product enforcement is UI-only; real enforcement for paid tiers has to
  live wherever the resource is actually spent, not in this browser.
- Research artifacts are append-only (CRDT-lite, not general CRDT):
  concurrent additions coexist as siblings rather than merging.
- Two of your own identities in the same browser tab can never become
  real WebRTC peers of each other — Trystero gives one tab one peer id.
  Local testing scores them against each other anyway, in the same
  results list as a real peer.

## Browser requirements

- WebRTC and IndexedDB (all modern browsers).
- WebGPU for local AI (currently Chrome/Edge on desktop) — its absence
  disables only the AI buttons, everything else keeps working.
