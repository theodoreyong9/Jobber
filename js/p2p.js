// p2p.js — real peer-to-peer transport. No Jobber backend anywhere.
//
// Trystero opens actual WebRTC data channels between browsers and uses public
// BitTorrent trackers purely to help two peers find each other's connection
// info (the "torrent" strategy). Swap the import for 'trystero/nostr' to use
// public Nostr relays instead — either way, no server we operate is involved,
// and no application data ever passes through that discovery layer.

import { joinRoom } from 'https://esm.sh/trystero/torrent';
import { validateMessage, createMessage } from './protocol.js';

const APP_ID = 'jobber-personal-interoperable-agency';
const rooms = new Map(); // namespace -> room handle

export function joinNamespaceRoom(namespace, handlers = {}) {
  if (rooms.has(namespace)) return rooms.get(namespace);

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
    send(type, senderId, payload, targetPeerId) {
      const msg = createMessage(type, namespace, senderId, payload);
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
