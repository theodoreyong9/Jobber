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

export async function joinNamespaceRoom(namespace, handlers = {}) {
  if (rooms.has(namespace)) return rooms.get(namespace);

  const joinRoom = await loadTrystero();
  const room = joinRoom({ appId: APP_ID, relayUrls: NOSTR_RELAY_URLS }, `jobber-${namespace}`);
  const msgAction = room.makeAction('jobber-msg');
  const blobAction = room.makeAction('jobber-blob');

  const peers = new Set();

  room.onPeerJoin = (peerId) => {
    peers.add(peerId);
    handlers.onPeerJoin && handlers.onPeerJoin(peerId);
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

  const entry = {
    namespace,
    peers,
    send(type, senderId, payload, targetPeerId, correlationId) {
      const msg = createMessage(type, namespace, senderId, payload, correlationId ? { correlationId } : {});
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
  return entry;
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
