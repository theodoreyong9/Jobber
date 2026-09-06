// p2p.js — real peer-to-peer transport. No Jobber backend anywhere.
//
// Trystero opens actual WebRTC data channels between browsers and uses public
// BitTorrent trackers purely to help two peers find each other's connection
// info (the "torrent" strategy). Swap TRYSTERO_URL for the "nostr" build to
// use public Nostr relays instead — either way, no server we operate is
// involved, and no application data ever passes through that layer.
//
// We load the pre-bundled browser file straight from jsdelivr instead of
// letting esm.sh resolve the package's subpath export (`trystero/torrent`):
// esm.sh's CJS/export-map interop for that subpath doesn't reliably expose
// a named `joinRoom` export, which crashes the whole module graph if done
// as a static top-level import. Loading it lazily with dynamic import()
// means a CDN hiccup only disables P2P — identity, profiles, and Research
// still work offline.

import { validateMessage, createMessage } from './protocol.js';

const APP_ID = 'jobber-personal-interoperable-agency';
const TRYSTERO_URL = 'https://cdn.jsdelivr.net/npm/trystero/dist/trystero-torrent.min.js';

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
