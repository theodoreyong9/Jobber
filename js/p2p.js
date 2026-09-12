// p2p.js — real peer-to-peer transport. No Jobber backend anywhere.
//
// Trystero opens actual WebRTC data channels between browsers and uses a
// public rendezvous layer purely to help two peers find each other's
// connection info — no application data ever passes through it. This uses
// the "nostr" strategy (public Nostr relays) rather than "torrent" (public
// BitTorrent trackers): trackers are geo/network-inconsistent in practice
// from plain browser JS, which was the actual cause of "discovery just
// doesn't connect" reports — Nostr relays over plain WebSocket are far more
// reliably reachable. The relay list is pinned explicitly rather than left
// to Trystero's default, for the same reliability reason.
//
// Trystero's current releases ship as plain ESM source (no bundled `dist/`
// files anymore), split into scoped packages per strategy
// (`@trystero-p2p/torrent`, `@trystero-p2p/nostr`, ...) as of v0.23 — the
// old `trystero/<strategy>` subpath imports still exist but are deprecated
// compatibility shims now, which is worth resolving directly rather than
// relying on. We resolve through esm.run (jsdelivr's dedicated ESM
// endpoint) rather than esm.sh: esm.sh's CJS/export-map interop for this
// kind of subpath doesn't reliably expose a named `joinRoom` export (the
// same failure mode we hit with WebLLM, fixed the same way in llm.js).
// Loading it lazily with dynamic import() means a CDN hiccup only disables
// P2P — identity, profiles, and Research still work offline.

import { validateMessage, createMessage } from './protocol.js';

const APP_ID = 'jobber-personal-interoperable-agency';
// Pinned to an exact version, checked against @trystero-p2p/nostr@0.25.4's
// actual published source (installed and read directly — not guessed):
// room.onPeerJoin/onPeerLeave are getter/setter properties (assign a
// handler, don't call them), and room.makeAction() returns an
// { send, onMessage } object — onMessage is also a property to assign, not
// a second function to call. Both are handled below in that exact shape.
// Bump this version deliberately, not by accident — a silent "latest"
// drift is what breaks this integration.
const TRYSTERO_URL = 'https://esm.run/@trystero-p2p/nostr@0.25.4';

// Well-known, generally reliable public Nostr relays. Any peer using any
// subset that overlaps with another peer's list can still find them —
// redundancy here is for resilience, not agreement on One True Relay.
const NOSTR_RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.snort.social',
];

const rooms = new Map(); // namespace -> room handle
let joinRoomFn = null;
let loadPromise = null;

async function loadTrystero() {
  if (joinRoomFn) return joinRoomFn;
  if (!loadPromise) {
    loadPromise = import(TRYSTERO_URL).then((mod) => {
      const fn = mod.joinRoom || mod.default?.joinRoom;
      if (typeof fn !== 'function') {
        throw new Error('Trystero loaded but no joinRoom export was found — the CDN build may have changed.');
      }
      joinRoomFn = fn;
      return fn;
    });
  }
  return loadPromise;
}

// One real Trystero room per namespace, full stop — the room id has to stay
// identity-agnostic (`jobber-${namespace}`, never sharded per identity), or
// two strangers in the same namespace couldn't find each other without
// already knowing each other's identityId in advance. More than one of my
// own identities can be "live" in that namespace at once (see state.js's
// searchLive), and they all ride this one connection — Trystero mints
// exactly one `selfId` per browser tab, shared by every room it joins, so
// there is no way to give two of my identities two independent WebRTC
// connections from the same tab even if we wanted to.
//
// `onMessage`/`onBlob`/`onPeerLeave` are wired exactly once per room, from
// whichever identity happens to be first to go live: they're about the wire
// itself (an incoming message, a peer disconnecting) and message-router.js
// decides which of my identities it's actually for using the message's own
// `targetIdentityId`/`sender`, not by which identity's closure happens to
// be listening. `onPeerJoin` is the one genuinely per-identity callback —
// each live identity announces itself separately — so it's tracked per
// identityId and fanned out below, including a manual replay for peers who
// were already in the room before this identity went live.
export async function joinNamespaceRoom(namespace, identityId, handlers = {}) {
  let entry = rooms.get(namespace);
  if (!entry) {
    const joinRoom = await loadTrystero();
    const room = joinRoom({ appId: APP_ID, relayUrls: NOSTR_RELAY_URLS }, `jobber-${namespace}`);
    const msgAction = room.makeAction('jobber-msg');
    const blobAction = room.makeAction('jobber-blob');
    const peers = new Set();
    const identityJoinHandlers = new Map(); // identityId -> onPeerJoin(peerId)

    room.onPeerJoin = (peerId) => {
      peers.add(peerId);
      for (const onPeerJoin of identityJoinHandlers.values()) onPeerJoin?.(peerId);
    };

    room.onPeerLeave = (peerId) => {
      peers.delete(peerId);
      handlers.onPeerLeave && handlers.onPeerLeave(peerId);
    };

    msgAction.onMessage = (data, meta) => {
      const v = validateMessage(data);
      if (!v.ok) {
        console.warn('[jobber/p2p] dropped invalid message from', meta.peerId, '-', v.reason);
        return;
      }
      handlers.onMessage && handlers.onMessage(data, meta.peerId);
    };

    blobAction.onMessage = (data, meta) => {
      handlers.onBlob && handlers.onBlob(data, meta.peerId, meta.metadata || {});
    };

    entry = {
      namespace,
      peers,
      identityJoinHandlers,
      send(type, senderId, payload, targetPeerId, correlationId, targetIdentityId) {
        const extra = {};
        if (correlationId) extra.correlationId = correlationId;
        if (targetIdentityId) extra.targetIdentityId = targetIdentityId;
        const msg = createMessage(type, namespace, senderId, payload, extra);
        msgAction.send(msg, { target: targetPeerId });
        return msg;
      },
      sendBlob(blob, targetPeerId, metadata) {
        return blobAction.send(blob, { target: targetPeerId, metadata });
      },
      leave() {
        room.leave();
        rooms.delete(namespace);
      },
    };
    rooms.set(namespace, entry);
  }

  entry.identityJoinHandlers.set(identityId, handlers.onPeerJoin);
  // Peers who connected before this particular identity went live never
  // fire a fresh Trystero onPeerJoin for it (I'm not a new WebRTC peer,
  // just a second identity riding the connection that's already open) —
  // replay it manually so they still learn about this identity.
  for (const peerId of entry.peers) handlers.onPeerJoin?.(peerId);
  return entry;
}

// Drops one identity's presence from the room; the room itself is only
// actually left once the *last* live identity in this namespace leaves.
export function leaveIdentityFromRoom(namespace, identityId) {
  const entry = rooms.get(namespace);
  if (!entry) return;
  entry.identityJoinHandlers.delete(identityId);
  if (entry.identityJoinHandlers.size === 0) entry.leave();
}

export function leaveNamespaceRoom(namespace) {
  const entry = rooms.get(namespace);
  if (entry) entry.leave();
}

export function getRoom(namespace) {
  return rooms.get(namespace);
}

export function peerCountAcrossRooms() {
  let n = 0;
  for (const r of rooms.values()) n += r.peers.size;
  return n;
}
