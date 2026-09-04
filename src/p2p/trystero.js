// src/p2p/trystero.js
//
// Établit les connexions directes navigateur-à-navigateur via Trystero et
// transporte le matching + le chat (§10, §39). La lib est injectée pour
// rester testable ; en prod, importer `trystero/nostr` (Trystero supporte
// Nostr comme mécanisme de signalisation, ce qui unifie avec §9).

import { validateIncomingMessage } from '../core/validation/schema.js';
import { limitForType } from './protocol.js';

/**
 * Rejoint une "room" Trystero dédiée au matching. Une room par contexte
 * applicatif (ex: "jobmatch-v1") suffit ; le filtrage se fait au niveau
 * applicatif (CPU + profils), pas au niveau réseau.
 * @param {{ joinRoom: (config: any, roomId: string) => any }} trysteroLib
 * @param {{ appId: string }} config
 * @param {string} roomId
 */
export function joinMatchingRoom(trysteroLib, config, roomId) {
  const room = trysteroLib.joinRoom(config, roomId);

  const [sendRaw, getRaw] = room.makeAction('jm_msg');

  /** @type {Set<(msg: any, peerId: string) => void>} */
  const listeners = new Set();

  getRaw((data, peerId) => {
    // Toute donnée reçue d'un pair est non fiable par défaut (§55).
    const limit = limitForType(data?.type) ?? 16 * 1024;
    const validation = validateIncomingMessage(data, limit);
    if (!validation.ok) {
      // On journalise localement sans jamais logguer le contenu intégral (§76).
      console.warn('[trystero] message rejeté', peerId, validation.errors);
      return;
    }
    listeners.forEach((fn) => fn(validation.value, peerId));
  });

  return {
    room,
    /** Envoie un message typé (déjà construit via p2p/protocol.js) à tous les pairs ou un pair ciblé. */
    send(message, targetPeerId) {
      sendRaw(message, targetPeerId);
    },
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onPeerJoin(fn) { room.onPeerJoin(fn); },
    onPeerLeave(fn) { room.onPeerLeave(fn); },
    leave() { room.leave(); },
  };
}
