// p2p.js — real peer-to-peer transport. No Jobber backend anywhere.
//
// Trystero opens actual WebRTC data channels between browsers and uses public
// BitTorrent trackers purely to help two peers find each other's connection
// info (the "torrent" strategy). Swap TRYSTERO_URL for "trystero/nostr" to
// use public Nostr relays instead — either way, no server we operate is
// involved, and no application data ever passes through that layer.
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
const TRYSTERO_URL = 'https://esm.run/@trystero-p2p/torrent';

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
  const room = joinRoom({ appId: APP_ID }, `jobber-${namespace}`);
  const [sendMsg, getMsg] = room.makeAction('jobber-msg');
  const [sendBlob, getBlob] = room.makeAction('jobber-blob');

  const peers = new Set();

  room.onPeerJoin((peerId) => {
    peers.add(peerId);
    handlers.onPeerJoin && handlers.onPeerJoin(peerId);
  });

  room.onPeerLeave((peerId) => {
    peers.delete(peerId);
    handlers.onPeerLeave && handlers.onPeerLeave(peerId);
  });

  getMsg((data, peerId) => {
    const v = validateMessage(data);
    if (!v.ok) {
      console.warn('[jobber/p2p] dropped invalid message from', peerId, '-', v.reason);
      return;
    }
    handlers.onMessage && handlers.onMessage(data, peerId);
  });

  getBlob((data, peerId, metadata) => {
    handlers.onBlob && handlers.onBlob(data, peerId, metadata || {});
  });

  const entry = {
    namespace,
    peers,
    send(type, senderId, payload, targetPeerId, correlationId) {
      const msg = createMessage(type, namespace, senderId, payload, correlationId ? { correlationId } : {});
      sendMsg(msg, targetPeerId);
      return msg;
    },
    sendBlob(blob, targetPeerId, metadata) {
      return sendBlob(blob, targetPeerId, metadata);
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
